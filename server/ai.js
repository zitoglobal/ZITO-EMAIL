import dns from 'node:dns';
import https from 'node:https';
import { URL } from 'node:url';
import { sanitizeGlossary } from './glossary.js';
import { isBlockedHostname } from './net_guard.js';

// Prefer IPv4 for outbound AI calls. Production Node fetch to Aliyun Bailian
// token-plan ETIMEDOUT under IPv6/Happy Eyeballs; NODE_OPTIONS ipv4first alone
// was not enough. CORE hotfixed with https.request({ family: 4 }); this matches.
dns.setDefaultResultOrder('ipv4first');

const BASE_URL = () =>
  (process.env.AI_BASE_URL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const API_KEY = () => process.env.AI_API_KEY || '';

/**
 * 多模型自动路由（阿里百炼 OpenAI 兼容）：
 * - strong：写信/回复（默认 AI_MODEL）
 * - mid：摘要/翻译/润色（AI_MODEL_MID，未设则同 strong）
 * - fast：分诊/简报（AI_MODEL_FAST，未设则同 mid）
 * 另按问题复杂度升降档 / 开关深度思考（AI_AUTO_ROUTE，默认开）。
 */
export function aiModels() {
  // 个人版 Token Plan 默认三档（可用名以控制台为准；未设 env 时用下列实测可用组合）
  const strong =
    String(process.env.AI_MODEL_STRONG || process.env.AI_MODEL || 'qwen3.8-max').trim() || 'qwen3.8-max';
  const mid = String(process.env.AI_MODEL_MID || 'deepseek-v4.1-flash').trim() || strong;
  const fast = String(process.env.AI_MODEL_FAST || 'qwen3.6-flash').trim() || mid;
  return { fast, mid, strong, default: strong };
}

export function modelFor(tier = 'strong') {
  const m = aiModels();
  if (tier === 'fast') return m.fast;
  if (tier === 'mid') return m.mid;
  return m.strong;
}

/** 是否启用「按任务 + 问题复杂度」自动路由（默认开） */
export function autoRouteEnabled() {
  const v = String(process.env.AI_AUTO_ROUTE ?? '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

const HARD_RE =
  /\b(complaint|dispute|claim|lawsuit|LC\b|L\/C|letter of credit|proforma|PI\b|PO\b|purchase order|contract|penalty|urgent|ASAP|索赔|投诉|仲裁|信用证|合同|违约|交期延误|质量问题|拒收|退货|紧急)\b/i;

/**
 * 估计问题难度 0–100（供自动选模 / 是否开思考）。
 * @param {{ subject?: string, text?: string, body?: string, instruction?: string, prompt?: string, bizContext?: string, itemCount?: number }} ctx
 */
export function scoreComplexity(ctx = {}) {
  const blob = [ctx.subject, ctx.text, ctx.body, ctx.instruction, ctx.prompt, ctx.bizContext]
    .map((x) => String(x || ''))
    .join('\n');
  let score = 0;
  const len = blob.replace(/\s+/g, ' ').trim().length;
  if (len > 400) score += 10;
  if (len > 1200) score += 15;
  if (len > 3000) score += 20;
  if (HARD_RE.test(blob)) score += 35;
  if (/已超时|overdue|SLA/i.test(blob)) score += 15;
  if (/付款|payment|deposit|尾款|定金/i.test(blob)) score += 12;
  if ((Number(ctx.itemCount) || 0) >= 8) score += 10;
  return Math.min(100, score);
}

/**
 * 按任务类型 + 问题内容自动决定档位与是否深度思考。
 * @param {'triage'|'digest'|'summarize'|'translate'|'rewrite'|'reply'|'compose'} task
 * @param {object} [ctx]
 * @returns {{ tier: 'fast'|'mid'|'strong', enableThinking: boolean, model: string, complexity: number, reason: string }}
 */
export function routeForTask(task, ctx = {}) {
  const complexity = scoreComplexity(ctx);
  const models = aiModels();
  const auto = autoRouteEnabled();

  /** @type {'fast'|'mid'|'strong'} */
  let tier = 'mid';
  let enableThinking = false;
  let reason = '';

  switch (task) {
    case 'triage':
    case 'digest':
      tier = 'fast';
      enableThinking = false;
      reason = '批量轻任务→快模、关思考';
      break;
    case 'summarize':
    case 'translate':
    case 'rewrite':
      tier = 'mid';
      enableThinking = false;
      reason = '理解/改写→中模、关思考';
      if (auto && complexity >= 55) {
        tier = 'strong';
        reason = `内容较难(${complexity})→升强模`;
      }
      break;
    case 'reply':
    case 'compose':
      tier = 'strong';
      enableThinking = false;
      reason = '写信/回复→强模';
      if (auto && complexity >= 45) {
        enableThinking = process.env.AI_THINKING_STRONG !== '0';
        reason = `复杂商务信(${complexity})→强模` + (enableThinking ? '+思考' : '');
      }
      break;
    default:
      tier = 'mid';
      reason = '默认中模';
  }

  if (!auto) {
    enableThinking = task === 'reply' || task === 'compose' ? process.env.AI_THINKING_STRONG !== '0' : false;
    reason = 'AI_AUTO_ROUTE 关闭，仅按任务档';
  }

  return {
    tier,
    enableThinking,
    model: modelFor(tier),
    complexity,
    reason,
    models,
    autoRoute: auto,
  };
}

export function aiConfigured() {
  return !!API_KEY();
}

/** 仅主机名，供设置页披露「邮件会发往何处」 */
export function aiVendorHost() {
  try {
    return new URL(BASE_URL()).hostname || '';
  } catch {
    return '';
  }
}

const AI_TIMEOUT_MS = 90_000;

/** POST JSON over IPv4-only https.request (avoids bare fetch/undici path). */
async function httpsPostJson(urlStr, bodyObj, { headers = {}, timeoutMs = AI_TIMEOUT_MS } = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') {
    throw new Error(`AI_BASE_URL must be https (got ${u.protocol})`);
  }
  if (isBlockedHostname(u.hostname)) {
    throw new Error('AI_BASE_URL 不允许指向内网或本机地址');
  }
  // 连接前解析 DNS，拒绝落到私网（防 DNS 重绑定 / 误配）
  try {
    const addrs = await dns.promises.lookup(u.hostname, { all: true, verbatim: true });
    for (const a of addrs || []) {
      if (isBlockedHostname(a.address)) {
        throw new Error('AI_BASE_URL 解析到内网地址，已拒绝连接');
      }
    }
  } catch (e) {
    if (/内网|不允许/.test(e.message || '')) throw e;
    throw new Error(`无法解析 AI 服务域名：${u.hostname}`);
  }
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`AI 请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function friendlyAiError(e) {
  const msg = String(e?.message || e || '');
  if (/超时|ETIMEDOUT|timeout/i.test(msg)) return new Error('AI 服务超时，请稍后重试');
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|socket|network|fetch failed/i.test(msg)) {
    return new Error('AI 服务暂时不可达，请稍后重试');
  }
  if (/返回错误 401|Unauthorized/i.test(msg)) return new Error('AI 密钥无效，请检查服务器 AI_API_KEY');
  if (/返回错误 429/i.test(msg)) return new Error('AI 调用过于频繁，请稍后再试');
  return e instanceof Error ? e : new Error(msg || 'AI 调用失败');
}

async function chatOnce(
  messages,
  { json = false, temperature = 0.4, maxTokens = 1500, tier = 'strong', model, enableThinking, timeoutMs } = {}
) {
  if (!aiConfigured()) throw new Error('AI 未配置：请在服务器 .env 中设置 AI_API_KEY（以及 AI_BASE_URL / AI_MODEL）');
  const useModel = String(model || modelFor(tier)).trim() || modelFor('strong');
  // qwen3.8-max 默认深度思考：分诊/摘要易拖到 30–90s 触发超时。轻/中任务默认关思考。
  const thinking =
    enableThinking != null ? !!enableThinking : tier === 'strong' && process.env.AI_THINKING_STRONG !== '0';
  const { status, text } = await httpsPostJson(
    `${BASE_URL()}/chat/completions`,
    {
      model: useModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      enable_thinking: thinking,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    },
    { headers: { Authorization: `Bearer ${API_KEY()}` }, timeoutMs: timeoutMs || AI_TIMEOUT_MS }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`AI 服务返回错误 ${status}：${text.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('AI 返回格式异常，请重试');
  }
  const content = data.choices?.[0]?.message?.content || '';
  if (!json) return content.trim();
  const m = content.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : content);
  } catch {
    throw new Error('AI 返回格式异常，请重试');
  }
}

/** 网络类错误自动重试 1 次，并转成可读中文错误 */
async function chat(messages, opts = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await chatOnce(messages, opts);
    } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      const retryable = /超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket|network|fetch failed/i.test(msg);
      if (attempt === 0 && retryable) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      throw friendlyAiError(e);
    }
  }
  throw friendlyAiError(last);
}

function mailContext(m) {
  const from = m.from ? `${m.from.name || ''} <${m.from.address || ''}>` : '';
  const body = String(m.text || m.body || '').replace(/\n{3,}/g, '\n\n').slice(0, 8000);
  const history = m.history?.length ? `\n\n此前的往来（供参考）：\n${m.history.join('\n')}` : '';
  return `发件人：${from}\n主题：${m.subject || ''}\n日期：${m.date || ''}\n\n正文：\n${body}${history}`;
}

const SYSTEM =
  '你是 ZITO 智能邮箱的 AI 助理，服务于外贸服装（成衣 OEM/ODM）企业。你熟悉询盘→报价→样品（色卡/Fit/PP）→大货→付款→出货链路，用语专业简洁；涉及面料、尺码、MOQ、交期、贸易术语时用行业惯用英文（海外客户）或中英对照（国内协作），绝不编造邮件中没有的价格、日期、数量等事实，未知处用 [ ] 占位。';

/** Heuristic language tag for mail body: '中文' | 'English' | '其他'. */
export function detectLang(text) {
  const s = String(text || '').slice(0, 4000);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 8 && cjk >= latin * 0.4) return '中文';
  if (latin >= 20 && latin > cjk * 2) return 'English';
  if (cjk > latin) return '中文';
  if (latin > 0) return 'English';
  return '其他';
}

function glossaryHint(glossary) {
  const entries = sanitizeGlossary(glossary);
  if (!entries.length) return '';
  return (
    '\n\n术语表（请严格按对应关系使用，不要改写术语本身）：\n' +
    entries.map((e) => `- ${e.src} → ${e.dst}`).join('\n')
  );
}


export async function summarize(mail) {
  const route = routeForTask('summarize', {
    subject: mail?.subject,
    text: mail?.text || mail?.body,
  });
  return chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `请分析下面这封邮件，用简体中文输出 JSON：
{
  "summary": "一两句话概括核心内容",
  "keyPoints": ["要点，最多5条"],
  "actionItems": ["我方需要做的事，没有则为空数组"],
  "urgency": "high|medium|low",
  "sentiment": "positive|neutral|negative",
  "category": "询盘|订单|报价|样品|物流|付款|投诉|合作|通知|营销|其他",
  "quickReplies": ["3 条可直接用于回复的简短意图，例如：确认收到并会尽快报价"],
  "replyLanguage": "原邮件所用语言，如 English / 中文"
}

${mailContext(mail)}`,
      },
    ],
    { json: true, temperature: 0.2, tier: route.tier, enableThinking: route.enableThinking, model: route.model }
  );
}

const TONES = {
  professional: '专业得体',
  friendly: '亲切友好',
  formal: '正式严谨',
  concise: '简洁直接',
  persuasive: '有说服力的销售口吻',
};

export async function draftReply(
  mail,
  { instruction = '', tone = 'professional', language = '', signature = '', glossary = [], bizContext = '' } = {}
) {
  const lang = language || '与原邮件相同的语言';
  const route = routeForTask('reply', {
    subject: mail?.subject,
    text: mail?.text || mail?.body,
    instruction,
    bizContext,
  });
  const text = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `请为下面这封邮件撰写回复正文。
要求：
- 语气：${TONES[tone] || tone}
- 语言：${lang}
- 回复意图：${instruction || '根据邮件内容与业务上下文给出合适回复'}
- 只输出正文（含称呼和结尾敬语），不要输出主题行，不要用 Markdown，不要编造价格、日期等未知信息，需要时用 [ ] 占位
- 若业务上下文标明阶段/SLA/认领状态，回复策略必须与之匹配（例如报价中勿重新询价开场；已超时可礼貌催推进度）
${signature ? `- 结尾署名使用：${signature}` : ''}${glossaryHint(glossary)}${bizContext || ''}

${mailContext(mail)}`,
      },
    ],
    {
      temperature: 0.6,
      tier: route.tier,
      enableThinking: route.enableThinking,
      model: route.model,
      timeoutMs: route.enableThinking ? 120_000 : AI_TIMEOUT_MS,
    }
  );
  return { body: text, aiRoute: { tier: route.tier, thinking: route.enableThinking, reason: route.reason } };
}

export async function compose({ prompt, tone = 'professional', language = '', to = '', signature = '', glossary = [] }) {
  const route = routeForTask('compose', { prompt });
  const out = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `请根据需求写一封新邮件，输出 JSON：{"subject": "主题", "body": "正文（纯文本，含称呼和落款，段落间空行）"}
需求：${prompt}
收件人：${to || '未指定'}
语气：${TONES[tone] || tone}
语言：${language || '根据需求判断，海外客户默认英文'}
${signature ? `署名：${signature}` : ''}${glossaryHint(glossary)}
不要编造具体价格、日期等信息，需要时用 [ ] 占位。`,
      },
    ],
    {
      json: true,
      temperature: 0.7,
      tier: route.tier,
      enableThinking: route.enableThinking,
      model: route.model,
      timeoutMs: route.enableThinking ? 120_000 : AI_TIMEOUT_MS,
    }
  );
  return {
    subject: out?.subject || '',
    body: out?.body || '',
    aiRoute: { tier: route.tier, thinking: route.enableThinking, reason: route.reason },
  };
}

const REWRITE = {
  polish: '润色这段邮件文字，修正语法和用词，使其更通顺专业，保持原语言和原意',
  shorten: '精简这段邮件文字，保留关键信息，篇幅缩短约一半，保持原语言',
  expand: '在不编造事实的前提下扩写这段邮件文字，使其更完整礼貌，保持原语言',
  formal: '把这段邮件文字改写得更正式、商务，保持原语言',
  friendly: '把这段邮件文字改写得更亲切友好，保持原语言',
  en: '把这段邮件文字翻译成地道的商务英文',
  zh: '把这段邮件文字翻译成简体中文',
};

export async function rewrite(text, mode, glossary = []) {
  const task = REWRITE[mode] || mode;
  const route = routeForTask('rewrite', { text });
  const out = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${task}。只输出结果文本，不要解释，不要 Markdown。${glossaryHint(glossary)}\n\n${String(text).slice(0, 8000)}`,
      },
    ],
    { temperature: 0.4, tier: route.tier, enableThinking: route.enableThinking, model: route.model }
  );
  return { text: out };
}

export async function translate(mail, target = '简体中文', glossary = []) {
  const guessed = detectLang(mail.text || mail.body || '');
  const route = routeForTask('translate', { subject: mail?.subject, text: mail?.text || mail?.body });
  const out = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `把下面邮件的主题和正文翻译成${target}，输出 JSON：{"subject":"...","body":"...","sourceLang":"原邮件主要语言，如 English / 中文"}。保留段落结构。${glossaryHint(glossary)}\n\n${mailContext(mail)}`,
      },
    ],
    {
      json: true,
      temperature: 0.2,
      maxTokens: 3000,
      tier: route.tier,
      enableThinking: route.enableThinking,
      model: route.model,
    }
  );
  const sourceLang = out.sourceLang || guessed;
  return { subject: out.subject || '', body: out.body || '', sourceLang };
}

/**
 * 待回复邮件逐封：一句话建议 + 可执行动作。
 * items[].context 为业务状态摘要（可选）。
 */
export async function triage(items) {
  const list = items
    .map((m) => {
      const ctx = m.context ? `｜状态：${m.context}` : '';
      const preview = String(m.bodyExcerpt || m.snippet || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 420);
      return `[uid:${m.uid}] 来自 ${m.from?.name || ''} <${m.from?.address || ''}>｜主题：${m.subject}｜正文要点：${preview}${ctx}`;
    })
    .join('\n');
  const route = routeForTask('triage', {
    text: list.slice(0, 2000),
    itemCount: items?.length || 0,
  });
  return chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `下面是等待我回复的客户邮件。请逐封用简体中文给出行动建议，并给出 1～3 个可在产品内一键执行的动作。
规则：
- note：不超过 30 字，以动词开头
- urgency：high|medium|low
- actions 仅允许 type：claim（认领，仅未认领时）、stage（推进阶段，stage 取 inquiry|quote|sample|bulk|payment|won）、snooze（hours 为数字）、reply（写回复，instruction 为简短意图）、followup（催单）、done（标记已处理）
- 不要建议与「状态」矛盾的动作（如已认领勿再 claim；已在 quote 勿再 stage=quote）
输出 JSON：
{"items":[{"uid":数字,"note":"行动建议","urgency":"high|medium|low","actions":[{"type":"claim|stage|snooze|reply|followup|done","label":"按钮文案","stage":"仅 stage 时","hours":4,"instruction":"仅 reply/followup 时"}]}]}

${list}`,
      },
    ],
    {
      json: true,
      temperature: 0.2,
      maxTokens: 1800,
      tier: route.tier,
      enableThinking: false,
      model: route.model,
      timeoutMs: 120_000,
    }
  );
}

export async function digest(items) {
  const list = items
    .slice(0, 36)
    .map((m, i) => {
      const kind =
        m.digestKind === 'need_reply'
          ? '待我回复'
          : m.digestKind === 'waiting'
            ? '等对方'
            : m.digestKind === 'unread'
              ? '未读补漏'
              : '邮件';
      const why = m.priority?.why || m.follow?.why || '';
      const tier = m.priority?.tier || m.follow?.tier || m.tier || '';
      return `${i + 1}. [uid:${m.uid}] [${kind}]${tier ? ` tier:${tier}` : ''}${why ? `｜${why}` : ''}｜来自 ${m.from?.name || m.from?.address}｜${m.subject}｜${(m.snippet || '').slice(0, 100)}`;
    })
    .join('\n');
  const route = routeForTask('digest', { text: list.slice(0, 1800), itemCount: items?.length || 0 });
  return chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `下面是「今日待办 / 等待对方」为主、少量未读客户信为辅的候选列表（已过滤通知订阅噪音）。请做销售向今日简报，输出 JSON：
{
  "overview": "一句话总体情况（突出超时/VIP/待回）",
  "priorities": [{"uid": 数字, "reason": "为什么需要优先处理", "action": "建议动作"}],
  "groups": [{"title": "主题分组名，如 客户询盘 / 订单物流 / 等待跟进", "uids": [数字], "summary": "该组概括"}]
}
priorities 最多 5 条，优先 [待我回复] 与 VIP/超时；不要把系统通知当优先。

${list}`,
      },
    ],
    {
      json: true,
      temperature: 0.2,
      maxTokens: 1600,
      tier: route.tier,
      enableThinking: false,
      model: route.model,
      timeoutMs: 120_000,
    }
  );
}
