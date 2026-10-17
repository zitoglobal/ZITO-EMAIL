import dns from 'node:dns';
import https from 'node:https';
import { URL } from 'node:url';
import { sanitizeGlossary } from './glossary.js';

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
 * 专家策略是「按任务选模」，不是一次打遍所有模型。
 */
export function aiModels() {
  const strong = String(process.env.AI_MODEL_STRONG || process.env.AI_MODEL || 'qwen3.8-max').trim() || 'qwen3.8-max';
  const mid = String(process.env.AI_MODEL_MID || strong).trim() || strong;
  const fast = String(process.env.AI_MODEL_FAST || mid).trim() || mid;
  return { fast, mid, strong, default: strong };
}

export function modelFor(tier = 'strong') {
  const m = aiModels();
  if (tier === 'fast') return m.fast;
  if (tier === 'mid') return m.mid;
  return m.strong;
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
function httpsPostJson(urlStr, bodyObj, { headers = {}, timeoutMs = AI_TIMEOUT_MS } = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') {
    return Promise.reject(new Error(`AI_BASE_URL must be https (got ${u.protocol})`));
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

const SYSTEM = '你是 ZITO 智能邮箱的 AI 助理，服务于一家外贸服装企业。你专业、简洁、准确，不编造邮件中没有的事实。';

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
    { json: true, temperature: 0.2, tier: 'mid' }
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
    { temperature: 0.6, tier: 'strong' }
  );
  return { body: text };
}

export async function compose({ prompt, tone = 'professional', language = '', to = '', signature = '', glossary = [] }) {
  return chat(
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
    { json: true, temperature: 0.7, tier: 'strong' }
  );
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
  const out = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${task}。只输出结果文本，不要解释，不要 Markdown。${glossaryHint(glossary)}\n\n${String(text).slice(0, 8000)}`,
      },
    ],
    { temperature: 0.4, tier: 'mid' }
  );
  return { text: out };
}

export async function translate(mail, target = '简体中文', glossary = []) {
  const guessed = detectLang(mail.text || mail.body || '');
  const out = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `把下面邮件的主题和正文翻译成${target}，输出 JSON：{"subject":"...","body":"...","sourceLang":"原邮件主要语言，如 English / 中文"}。保留段落结构。${glossaryHint(glossary)}\n\n${mailContext(mail)}`,
      },
    ],
    { json: true, temperature: 0.2, maxTokens: 3000, tier: 'mid' }
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
    { json: true, temperature: 0.2, maxTokens: 1800, tier: 'fast', enableThinking: false, timeoutMs: 120_000 }
  );
}

export async function digest(items) {
  const list = items
    .slice(0, 30)
    .map((m, i) => `${i + 1}. [uid:${m.uid}] 来自 ${m.from?.name || m.from?.address}｜${m.subject}｜${(m.snippet || '').slice(0, 120)}`)
    .join('\n');
  return chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `下面是收件箱里的未读邮件，请帮我做一份今日邮件简报，输出 JSON：
{
  "overview": "一句话总体情况",
  "priorities": [{"uid": 数字, "reason": "为什么需要优先处理", "action": "建议动作"}],
  "groups": [{"title": "主题分组名，如 客户询盘 / 订单物流 / 系统通知", "uids": [数字], "summary": "该组概括"}]
}
priorities 最多 5 条，按重要程度排序。

${list}`,
      },
    ],
    { json: true, temperature: 0.2, maxTokens: 1600, tier: 'fast', enableThinking: false, timeoutMs: 120_000 }
  );
}
