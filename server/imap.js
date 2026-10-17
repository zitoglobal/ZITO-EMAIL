import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import libqp from 'libqp';
import iconv from 'iconv-lite';
import { decrypt } from './security.js';
import { classify } from './classify.js';
import * as oauth from './oauth.js';
import { assertSafeMailHost } from './net_guard.js';

const IDLE_CLOSE_MS = 10 * 60 * 1000;

export function friendlyImapError(e) {
  const raw = [e?.responseText, e?.message, e?.code].filter(Boolean).join(' ');
  const s = raw.toLowerCase();
  if (/oauth|token|invalid_grant|expired/.test(s) && /oauth|授权|令牌/.test(raw + s)) {
    return 'OAuth 授权已失效，请重新用 Google / Microsoft 一键绑定。';
  }
  if (e?.authenticationFailed || /authenticat|login fail|invalid credentials|password|auth fail|oauth/.test(s)) {
    return '登录失败：账号或密码错误。多数邮箱需要开启 IMAP 并使用「授权码 / 应用专用密码」；Gmail/Outlook 也可改用 OAuth 一键绑定。';
  }
  if (/enotfound|getaddrinfo/.test(s)) return '无法解析邮件服务器地址，请检查 IMAP 主机设置。';
  if (/timeout|timed out/.test(s)) return '连接邮件服务器超时，请稍后重试或检查端口设置。';
  if (/econnrefused|econnreset/.test(s)) return '邮件服务器拒绝连接，请检查主机与端口。';
  if (/certificate|ssl|tls|wrong version/.test(s)) return '与邮件服务器的加密连接失败，请检查 SSL 设置与端口是否匹配。';
  return raw || '邮件服务器出现未知错误';
}

export async function buildClient(mb, password) {
  // 连接前复检 DNS，缩小绑定时校验与实际连接之间的重绑定窗口
  await assertSafeMailHost(mb.imap_host, 'IMAP');
  let auth;
  if (mb.oauth_refresh_enc || mb.oauth_access_enc) {
    const accessToken = await oauth.ensureAccessToken(mb);
    auth = { user: mb.login_user || mb.email, accessToken };
  } else {
    auth = {
      user: mb.login_user || mb.email,
      pass: password ?? (mb.pass_enc === 'demo' ? '' : decrypt(mb.pass_enc)),
    };
  }
  const client = new ImapFlow({
    host: mb.imap_host,
    port: Number(mb.imap_port),
    secure: !!mb.imap_secure,
    auth,
    logger: false,
    socketTimeout: 5 * 60_000,
    greetingTimeout: 20_000,
    connectionTimeout: 20_000,
    maxIdleTime: 4 * 60_000,
    clientInfo: { name: 'ZITO Smart Mail', version: '2.0' },
  });
  client.on('error', () => {});
  return client;
}

export async function verifyLogin(mb, password) {
  const client = await buildClient(mb, password);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(friendlyImapError(e));
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------- 操作连接池（每个邮箱一条） ----------
/** @type {Map<string, {client: ImapFlow|null, connecting: Promise<ImapFlow>|null, timer: any}>} */
const pool = new Map();

function scheduleClose(id, entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (pool.get(id) === entry) pool.delete(id);
    entry.client?.logout().catch(() => {});
  }, IDLE_CLOSE_MS);
}

export async function getClient(mb) {
  const existing = pool.get(mb.id);
  if (existing?.client?.usable) {
    scheduleClose(mb.id, existing);
    return existing.client;
  }
  if (existing?.connecting) return existing.connecting;

  const entry = { client: null, connecting: null, timer: null };
  entry.connecting = (async () => {
    const client = await buildClient(mb);
    try {
      await client.connect();
      entry.client = client;
      entry.connecting = null;
      scheduleClose(mb.id, entry);
      client.on('close', () => {
        if (pool.get(mb.id) === entry) pool.delete(mb.id);
      });
      return client;
    } catch (e) {
      if (pool.get(mb.id) === entry) pool.delete(mb.id);
      const err = new Error(friendlyImapError(e));
      err.auth = !!e?.authenticationFailed;
      throw err;
    }
  })();
  pool.set(mb.id, entry);
  return entry.connecting;
}

export function dropClient(id) {
  const entry = pool.get(id);
  pool.delete(id);
  clearTimeout(entry?.timer);
  entry?.client?.logout().catch(() => {});
}

export async function withBox(mb, folder, fn, client) {
  const c = client || (await getClient(mb));
  const lock = await c.getMailboxLock(folder || 'INBOX');
  try {
    return await fn(c);
  } finally {
    lock.release();
  }
}

// ---------- 文件夹 ----------
const NAME_GUESS = [
  [/^(sent|sent messages|sent items|sent mail|已发送|已发送邮件)$/i, '\\Sent'],
  [/^(drafts?|草稿箱?)$/i, '\\Drafts'],
  [/^(trash|deleted|deleted messages|deleted items|已删除|垃圾桶|已删除邮件)$/i, '\\Trash'],
  [/^(junk|spam|junk e-?mail|垃圾邮件|垃圾箱)$/i, '\\Junk'],
  [/^(archives?|归档)$/i, '\\Archive'],
];

function guessSpecial(box) {
  if (box.path.toUpperCase() === 'INBOX') return '\\Inbox';
  if (box.specialUse) return box.specialUse;
  for (const [re, use] of NAME_GUESS) if (re.test(box.name)) return use;
  return null;
}

export async function listServerFolders(mb) {
  const client = await getClient(mb);
  const boxes = await client.list();
  const seen = new Set();
  return boxes
    .filter((b) => !b.flags?.has('\\Noselect') && !b.flags?.has('\\NonExistent'))
    .map((b) => {
      let special = guessSpecial(b);
      if (special && seen.has(special)) special = null;
      if (special) seen.add(special);
      return { path: b.path, name: b.name, delimiter: b.delimiter, specialUse: special };
    });
}

// ---------- 信封与预览 ----------
function walkStructure(node, out = { text: null, html: null, attachments: 0 }) {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const c of node.childNodes) walkStructure(c, out);
    return out;
  }
  const type = String(node.type || '').toLowerCase();
  const isAttachment =
    node.disposition === 'attachment' || (!type.startsWith('text/') && (node.dispositionParameters?.filename || node.parameters?.name));
  if (isAttachment) {
    if (!(node.disposition === 'inline' && node.id)) out.attachments++;
    return out;
  }
  const part = node.part || '1';
  if (type === 'text/plain' && !out.text) out.text = { part, encoding: node.encoding, charset: node.parameters?.charset };
  if (type === 'text/html' && !out.html) out.html = { part, encoding: node.encoding, charset: node.parameters?.charset };
  return out;
}

function decodePart(buf, info) {
  if (!buf) return '';
  let data = buf;
  const enc = String(info.encoding || '').toLowerCase();
  try {
    if (enc === 'base64') {
      const s = buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
      data = Buffer.from(s.slice(0, s.length - (s.length % 4)), 'base64');
    } else if (enc === 'quoted-printable') {
      data = libqp.decode(buf.toString('binary'));
    }
    const charset = String(info.charset || 'utf-8').toLowerCase();
    return iconv.encodingExists(charset) ? iconv.decode(data, charset) : data.toString('utf8');
  } catch {
    return '';
  }
}

function toSnippet(text, isHtml, maxLen = 200) {
  let s = text;
  if (isHtml) {
    s = s
      .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#\d+;|&\w+;/g, ' ');
  }
  return s
    .replace(/^>.*$/gm, ' ')
    .replace(/[\u200b-\u200f\u00ad\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function cleanMessageId(s) {
  return String(s || '')
    .trim()
    .replace(/^<|>$/g, '');
}

/** 会话根：References 首个 → In-Reply-To → 自身 Message-ID */
export function threadIdOf(messageId, inReplyTo, references) {
  const refs = String(references || '').match(/<[^>]+>/g) || [];
  const firstRef = cleanMessageId(refs[0]);
  const irt = cleanMessageId(inReplyTo);
  const mid = cleanMessageId(messageId);
  return firstRef || irt || mid || null;
}

function headerMap(buf) {
  const map = {};
  if (!buf) return map;
  const text = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return map;
}

const cleanId = cleanMessageId;

const addr = (list) => (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));

/**
 * 拉取信封 + 预览（调用方需已持有目标文件夹的锁）
 */
export async function fetchEnvelopes(client, range, { uid = true } = {}) {
  const items = [];
  for await (const msg of client.fetch(
    range,
    {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
      headers: [
        'list-unsubscribe',
        'list-id',
        'precedence',
        'auto-submitted',
        'references',
        'in-reply-to',
        'x-auto-response-suppress',
      ],
    },
    { uid }
  )) {
    items.push({ msg, st: walkStructure(msg.bodyStructure) });
  }

  const groups = new Map();
  for (const { msg, st } of items) {
    const info = st.text || st.html;
    if (!info) continue;
    const isHtml = !st.text;
    const gk = `${info.part}|${isHtml}`;
    if (!groups.has(gk)) groups.set(gk, { part: info.part, isHtml, targets: new Map() });
    groups.get(gk).targets.set(msg.uid, info);
  }
  /** uid → { snippet, preview }；preview 更长供入库算意图 */
  const previews = new Map();
  for (const g of groups.values()) {
    const uids = [...g.targets.keys()];
    for (let i = 0; i < uids.length; i += 100) {
      try {
        const query = { uid: true, bodyParts: [{ key: g.part, start: 0, maxLength: g.isHtml ? 12000 : 5000 }] };
        for await (const res of client.fetch(uids.slice(i, i + 100).join(','), query, { uid: true })) {
          const info = g.targets.get(res.uid);
          const buf = res?.bodyParts ? [...res.bodyParts.values()][0] : null;
          if (!info) continue;
          const raw = decodePart(buf, info);
          const preview = toSnippet(raw, g.isHtml, 2500);
          previews.set(res.uid, { snippet: preview.slice(0, 200), preview });
        }
      } catch {
        // 预览失败不影响同步
      }
    }
  }

  return items.map(({ msg, st }) => {
    const env = msg.envelope || {};
    const headers = headerMap(msg.headers);
    const from = addr(env.from)[0] || { name: '', address: '' };
    const date = env.date && !isNaN(new Date(env.date)) ? new Date(env.date) : msg.internalDate || new Date();
    const messageId = cleanId(env.messageId);
    const inReplyTo = cleanId(env.inReplyTo || headers['in-reply-to']);
    const pv = previews.get(msg.uid) || { snippet: '', preview: '' };
    const references = (String(headers.references || '').match(/<[^>]+>/g) || [])
      .map((x) => cleanId(x))
      .filter(Boolean);
    return {
      uid: msg.uid,
      messageId,
      inReplyTo: inReplyTo || null,
      references,
      threadId: threadIdOf(messageId, inReplyTo, headers.references),
      subject: env.subject || '',
      from,
      to: addr(env.to),
      cc: addr(env.cc),
      date: Math.min(new Date(date).getTime(), Date.now() + 3600_000),
      seen: msg.flags?.has('\\Seen') || false,
      flagged: msg.flags?.has('\\Flagged') || false,
      answered: msg.flags?.has('\\Answered') || false,
      hasAttachments: st.attachments > 0,
      size: msg.size || 0,
      snippet: pv.snippet || '',
      preview: pv.preview || pv.snippet || '',
      category: classify({ from, headers, subject: env.subject || '' }),
    };
  });
}

// ---------- 正文 ----------
const parsedCache = new Map();
const cacheKey = (mb, folder, uid) => `${mb.id}|${folder}|${uid}`;

export async function fetchParsed(mb, folder, uid) {
  const key = cacheKey(mb, folder, uid);
  if (parsedCache.has(key)) {
    const v = parsedCache.get(key);
    parsedCache.delete(key);
    parsedCache.set(key, v);
    return v;
  }
  const parsed = await withBox(mb, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg?.source) throw Object.assign(new Error('邮件不存在或已在其他客户端被删除'), { status: 404 });
    return simpleParser(msg.source);
  });
  parsedCache.set(key, parsed);
  while (parsedCache.size > 30) parsedCache.delete(parsedCache.keys().next().value);
  return parsed;
}

export function forgetParsed(mb, folder, uid) {
  parsedCache.delete(cacheKey(mb, folder, uid));
}

function inlineCidImages(html, attachments) {
  if (!html) return html;
  return html.replace(/(["'(])cid:([^"')\s]+)/gi, (m, q, cid) => {
    const a = attachments.find((x) => x.contentId && cleanId(x.contentId) === cid);
    if (!a || a.size > 3 * 1024 * 1024) return m;
    return `${q}data:${a.contentType};base64,${a.content.toString('base64')}`;
  });
}

function unsubscribeOf(p) {
  const pick = (url, mail) => {
    const safeUrl = /^https?:\/\//i.test(url || '') ? url : null;
    const safeMail = /^[^@\s<>]+@[^@\s<>]+$/.test(mail || '') ? mail : null;
    return safeUrl || safeMail ? { url: safeUrl, mail: safeMail } : null;
  };
  const list = p.headers?.get('list')?.unsubscribe;
  if (list) return pick(list.url, list.mail);
  const raw = p.headers?.get('list-unsubscribe');
  if (typeof raw === 'string') return pick(raw.match(/<(https?:[^>]+)>/i)?.[1], raw.match(/<mailto:([^>?]+)/i)?.[1]);
  return null;
}

export function serializeParsed(p) {
  const attachments = p.attachments || [];
  const html = p.html
    ? inlineCidImages(
        p.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<(iframe|object|embed)[\s\S]*?(<\/\1>|\/>)/gi, ''),
        attachments
      )
    : null;
  return {
    html,
    text: p.text || '',
    meta: {
      replyTo: addr(p.replyTo?.value),
      to: addr(p.to?.value),
      cc: addr(p.cc?.value),
      bcc: addr(p.bcc?.value),
      references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
      messageId: p.messageId || '',
      unsubscribe: unsubscribeOf(p),
      attachments: attachments
        .map((a, i) => ({
          index: i,
          filename: a.filename || `附件${i + 1}`,
          contentType: a.contentType,
          size: a.size,
          inline: a.contentDisposition === 'inline' && !!a.contentId && /^image\//.test(a.contentType || ''),
        }))
        .filter((a) => !a.inline),
    },
  };
}

export async function getAttachment(mb, folder, uid, index) {
  const p = await fetchParsed(mb, folder, uid);
  const a = p.attachments?.[Number(index)];
  if (!a) throw Object.assign(new Error('附件不存在'), { status: 404 });
  return a;
}

// ---------- 修改 ----------
const range = (uids) => uids.join(',');

export async function setFlags(mb, folder, uids, { seen, flagged, answered }) {
  return withBox(mb, folder, async (c) => {
    if (seen === true) await c.messageFlagsAdd(range(uids), ['\\Seen'], { uid: true });
    if (seen === false) await c.messageFlagsRemove(range(uids), ['\\Seen'], { uid: true });
    if (flagged === true) await c.messageFlagsAdd(range(uids), ['\\Flagged'], { uid: true });
    if (flagged === false) await c.messageFlagsRemove(range(uids), ['\\Flagged'], { uid: true });
    if (answered === true) await c.messageFlagsAdd(range(uids), ['\\Answered'], { uid: true });
  });
}

export async function moveMessages(mb, folder, uids, dest) {
  uids.forEach((u) => forgetParsed(mb, folder, u));
  return withBox(mb, folder, (c) => c.messageMove(range(uids), dest, { uid: true }));
}

export async function expungeMessages(mb, folder, uids) {
  uids.forEach((u) => forgetParsed(mb, folder, u));
  return withBox(mb, folder, (c) => c.messageDelete(range(uids), { uid: true }));
}

export async function appendMessage(mb, folder, raw, flags) {
  const client = await getClient(mb);
  return client.append(folder, raw, flags);
}

export async function searchUids(mb, folder, criteria) {
  return withBox(mb, folder, async (c) => ((await c.search(criteria, { uid: true })) || []).map(Number));
}
