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
const MODEL = () => process.env.AI_MODEL || 'qwen3.8-max';

export function aiConfigured() {
  return !!API_KEY();
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

async function chat(messages, { json = false, temperature = 0.4, maxTokens = 1500 } = {}) {
  if (!aiConfigured()) throw new Error('AI 未配置：请在服务器 .env 中设置 AI_API_KEY（以及 AI_BASE_URL / AI_MODEL）');
  const { status, text } = await httpsPostJson(
    `${BASE_URL()}/chat/completions`,
    {
      model: MODEL(),
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    },
    { headers: { Authorization: `Bearer ${API_KEY()}` } }
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
    { json: true, temperature: 0.2 }
  );
}

const TONES = {
  professional: '专业得体',
  friendly: '亲切友好',
  formal: '正式严谨',
  concise: '简洁直接',
  persuasive: '有说服力的销售口吻',
};

export async function draftReply(mail, { instruction = '', tone = 'professional', language = '', signature = '', glossary = [] } = {}) {
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
- 回复意图：${instruction || '根据邮件内容给出合适回复'}
- 只输出正文（含称呼和结尾敬语），不要输出主题行，不要用 Markdown，不要编造价格、日期等未知信息，需要时用 [ ] 占位
${signature ? `- 结尾署名使用：${signature}` : ''}${glossaryHint(glossary)}

${mailContext(mail)}`,
      },
    ],
    { temperature: 0.6 }
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
    { json: true, temperature: 0.7 }
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
    { temperature: 0.4 }
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
    { json: true, temperature: 0.2, maxTokens: 3000 }
  );
  const sourceLang = out.sourceLang || guessed;
  return { subject: out.subject || '', body: out.body || '', sourceLang };
}

/** 待回复邮件逐封给出「一句话要做什么」 */
export async function triage(items) {
  const list = items
    .map((m) => `[uid:${m.uid}] 来自 ${m.from?.name || ''} <${m.from?.address || ''}>｜主题：${m.subject}｜预览：${(m.snippet || '').slice(0, 200)}`)
    .join('\n');
  return chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `下面是等待我回复的客户邮件。请逐封用简体中文给出「我需要做什么」的一句话行动建议（不超过 30 字，以动词开头，如「确认 3000 件订单并发送 PI」），并判断紧急程度。输出 JSON：
{"items": [{"uid": 数字, "note": "行动建议", "urgency": "high|medium|low"}]}

${list}`,
      },
    ],
    { json: true, temperature: 0.2, maxTokens: 1800 }
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
    { json: true, temperature: 0.2, maxTokens: 2000 }
  );
}
