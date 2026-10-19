/**
 * 邮件链接：追踪跳转解包、协议分类、纯文本识别、深链拼装。
 * 纯 ESM，可被 Node 单测与 Vite 前端共用（无 Node API）。
 */

const TRACK_HOST_RE =
  /safelinks\.protection\.(?:outlook|office)\.com$|urldefense(?:\.proofpoint)?\.com$|(?:^|\.)(?:ct\.)?sendgrid\.net$|(?:^|\.)mimecast\.com$|(?:^|\.)mandrillapp\.com$|(?:^|\.)list-manage\.com$|(?:^|\.)click\.mailchimp(?:app)?\.com$|(?:^|\.)awstrack\.me$|(?:^|\.)lnk\.to$/i;

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s || '').replace(/\+/g, ' '));
  } catch {
    return String(s || '');
  }
}

/** Proofpoint urldefense v2：u=https-3A__example.com_x */
export function decodeProofpointU(uParam) {
  let s = String(uParam || '');
  if (!s) return '';
  s = s.replace(/_/g, '/').replace(/-/g, '%');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep partial */
  }
  return s;
}

function pickRedirectParam(u) {
  const keys = ['url', 'u', 'q', 'redirect', 'redirect_url', 'target', 'dest', 'destination', 'r', 'to', 'link'];
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

export function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

export function isMailtoUrl(s) {
  return /^mailto:/i.test(String(s || '').trim());
}

export function isTelUrl(s) {
  return /^tel:/i.test(String(s || '').trim());
}

/** 允许在邮件里打开的外链协议 */
export function isOpenableMailHref(s) {
  const t = String(s || '').trim();
  if (!t || /^\s*(javascript|vbscript|data):/i.test(t)) return false;
  return isHttpUrl(t) || isMailtoUrl(t) || isTelUrl(t);
}

/**
 * 剥常见企业邮件安全网关 / ESP 点击追踪（最多 maxHops 层）。
 * 解不出则返回原串。
 */
export function unwrapTrackingUrl(raw, { maxHops = 4 } = {}) {
  let cur = String(raw || '').trim();
  if (!cur) return '';
  for (let hop = 0; hop < maxHops; hop++) {
    let next = '';
    try {
      if (!isHttpUrl(cur)) break;
      const u = new URL(cur);
      const host = u.hostname.toLowerCase();
      if (host.includes('safelinks.protection.')) {
        next = u.searchParams.get('url') || u.searchParams.get('u') || '';
      } else if (host.includes('urldefense') || host.includes('proofpoint.com')) {
        const up = u.searchParams.get('u');
        next = up ? decodeProofpointU(up) : pickRedirectParam(u);
      } else if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') {
        next = u.searchParams.get('q') || u.searchParams.get('url') || '';
      } else if (TRACK_HOST_RE.test(host) || /\/(?:ls\/click|track|click|redirect)\b/i.test(u.pathname)) {
        next = pickRedirectParam(u);
      }
    } catch {
      break;
    }
    if (!next) break;
    next = safeDecode(next).trim();
    if (!next || next === cur) break;
    if (!isOpenableMailHref(next) && isHttpUrl(safeDecode(next))) next = safeDecode(next);
    if (!isOpenableMailHref(next)) break;
    cur = next;
  }
  return cur;
}

export function hostnameOf(href) {
  try {
    if (!isHttpUrl(href)) return '';
    return new URL(href).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** 锚文字里像域名、与真实 href 主机不一致 → 钓鱼提示 */
export function linkDisplayMismatch(anchorText, href) {
  const text = String(anchorText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !isHttpUrl(href)) return null;
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9.]+\.[a-z]{2,})(?:\/|\s|$)/i);
  if (!m) return null;
  const shown = m[1].replace(/^www\./i, '').toLowerCase();
  const real = hostnameOf(href);
  if (!real || shown === real) return null;
  if (real.endsWith('.' + shown) || shown.endsWith('.' + real)) return null;
  return { shown, real };
}

export function parseMailto(href) {
  const raw = String(href || '').trim();
  if (!isMailtoUrl(raw)) return null;
  try {
    const u = new URL(raw);
    const to = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
    return {
      to: to || '',
      subject: u.searchParams.get('subject') || '',
      body: u.searchParams.get('body') || '',
      cc: u.searchParams.get('cc') || '',
    };
  } catch {
    const rest = raw.slice(7);
    const [addr, qs] = rest.split('?');
    const sp = new URLSearchParams(qs || '');
    return {
      to: safeDecode(addr || ''),
      subject: sp.get('subject') || '',
      body: sp.get('body') || '',
      cc: sp.get('cc') || '',
    };
  }
}

export function classifyMailHref(href) {
  const raw = String(href || '').trim();
  if (!raw || /^\s*(javascript|vbscript|data):/i.test(raw)) return { kind: 'blocked', href: raw, final: '' };
  if (isMailtoUrl(raw)) return { kind: 'mailto', href: raw, final: raw, mailto: parseMailto(raw) };
  if (isTelUrl(raw)) return { kind: 'tel', href: raw, final: raw };
  if (!isHttpUrl(raw)) return { kind: 'other', href: raw, final: raw };
  const final = unwrapTrackingUrl(raw);
  return {
    kind: 'http',
    href: raw,
    final,
    unwrapped: final !== raw,
    host: hostnameOf(final),
  };
}

/** 去掉 URL 尾部常见标点（纯文本识别） */
export function trimUrlEdgePunct(url) {
  let s = String(url || '');
  while (/[),.;:!?'"」』】、，。；：！？]$/.test(s)) {
    const last = s.slice(-1);
    if (last === ')' && (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length - 1) break;
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * 纯文本 → 安全 HTML（转义 + http(s)/www/mailto 识别）。
 * 供 textToHtml 与单测共用。
 */
export function linkifyPlainText(text = '') {
  const esc = String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
  const re =
    /((?:https?:\/\/|www\.)[^\s<]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
  return esc
    .replace(re, (raw) => {
      const trimmed = trimUrlEdgePunct(raw);
      const trail = raw.slice(trimmed.length);
      let href = trimmed;
      let label = trimmed;
      if (/^www\./i.test(trimmed)) href = `https://${trimmed}`;
      else if (/^[^/]+@[^/]+$/i.test(trimmed) && !/^https?:/i.test(trimmed)) {
        href = `mailto:${trimmed}`;
      } else if (!/^https?:\/\//i.test(trimmed) && !/^mailto:/i.test(trimmed)) {
        return raw;
      }
      const safe = href.replace(/"/g, '&quot;');
      return `<a href="${safe}" rel="noopener noreferrer" target="_blank">${label}</a>${trail}`;
    })
    .replace(/\n/g, '<br>');
}

/** 读信深链（Push / 复制链接 / 服务号点达） */
export function buildMessageDeepLink({ origin = '', messageId, box = 'inbox', mailboxId } = {}) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return origin ? `${origin}/` : '/';
  const sp = new URLSearchParams();
  sp.set('messageId', String(id));
  if (box) sp.set('box', String(box));
  if (mailboxId != null && mailboxId !== '' && mailboxId !== 'all') sp.set('mailboxId', String(mailboxId));
  const q = sp.toString();
  const base = origin ? String(origin).replace(/\/$/, '') : '';
  return `${base}/?${q}`;
}

export function parseMessageDeepLink(searchOrUrl = '') {
  let search = String(searchOrUrl || '');
  try {
    if (search.includes('://') || search.startsWith('/')) {
      const u = new URL(search, 'https://mail.local');
      search = u.search;
    }
  } catch {
    /* treat as query */
  }
  if (search.startsWith('?')) search = search.slice(1);
  const sp = new URLSearchParams(search);
  const mid = Number(sp.get('messageId') || sp.get('id'));
  const box = sp.get('box') || 'inbox';
  const mailboxId = sp.get('mailboxId') || 'all';
  const compose = sp.get('compose') === '1';
  return {
    messageId: Number.isInteger(mid) && mid > 0 ? mid : null,
    box,
    mailboxId,
    compose,
  };
}

/** 消毒后锚点：title 显示最终地址，保留解包前原始 href 于 data-zm-href */
export function enrichAnchorAttribs(attribs = {}, text = '') {
  const href = String(attribs.href || '').trim();
  const info = classifyMailHref(href);
  const out = { ...attribs };
  if (info.kind === 'blocked' || !href) {
    delete out.href;
    return out;
  }
  if (info.kind === 'http') {
    out.href = info.final || href;
    if (info.unwrapped) out['data-zm-tracked'] = href;
    out.title = info.final || href;
    const mismatch = linkDisplayMismatch(text, info.final || href);
    if (mismatch) out['data-zm-mismatch'] = `${mismatch.shown}|${mismatch.real}`;
  } else {
    out.title = href;
  }
  out.rel = 'noopener noreferrer';
  out.target = '_blank';
  return out;
}
