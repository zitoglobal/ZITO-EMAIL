import {
  addrString, escapeHtml, formatFullDate, htmlToText, looksLikeHtml, prefixSubject, sanitizeHtml, textToHtml,
} from './utils.js';

export const BODY_STYLE = "font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6";

/** 签名 → 写信区 HTML；支持纯文本与含 data:image 的富文本 */
export function signatureHtml(sig) {
  const raw = String(sig || '').trim();
  if (!raw) return '';
  const inner = looksLikeHtml(raw) ? sanitizeHtml(raw) : textToHtml(raw);
  if (!inner.trim()) return '';
  return `<div class="zm-sig">${inner}</div>`;
}

/** 给 AI 用的签名纯文本（去掉 base64 噪声） */
export function signaturePlain(sig) {
  const raw = String(sig || '').trim();
  if (!raw) return '';
  if (!looksLikeHtml(raw)) return raw.slice(0, 400);
  return htmlToText(raw.replace(/<img\b[^>]*>/gi, ' [图片] ')).slice(0, 400);
}

const uniqBy = (list) => {
  const seen = new Set();
  return list.filter((a) => {
    const k = a?.address?.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * 根据原邮件生成写信初始状态。
 * ctx: { mailboxes, defaultMailboxId }
 */
export function buildComposeState(mode, msg, ctx, extra = {}) {
  const own = new Set(ctx.mailboxes.map((m) => m.email.toLowerCase()));
  const isOwn = (a) => a?.address && own.has(a.address.toLowerCase());
  const mailboxId = ctx.mailboxes.some((m) => m.id === msg?.mailboxId) ? msg.mailboxId : ctx.defaultMailboxId;

  if (!msg || mode === 'new') return { mode: 'new', mailboxId, to: '', cc: '', bcc: '', subject: '', ...extra };

  if (mode === 'draft') {
    return {
      mode: 'draft',
      mailboxId,
      to: (msg.to || []).map(addrString).join(', '),
      cc: (msg.cc || []).map(addrString).join(', '),
      bcc: (msg.bcc || []).map(addrString).join(', '),
      subject: msg.subject || '',
      body: msg.html ? sanitizeHtml(msg.html) : textToHtml(msg.text || ''),
      draftUid: msg.uid,
      draftId: msg.id,
      ...extra,
    };
  }

  const fromSelf = isOwn(msg.from);
  const primary = fromSelf ? msg.to || [] : msg.replyTo?.length ? msg.replyTo : [msg.from];
  let to = [];
  let cc = [];
  if (mode === 'reply') to = primary;
  if (mode === 'replyAll') {
    to = uniqBy([...primary, ...(fromSelf ? [] : (msg.to || []).filter((a) => !isOwn(a)))]);
    const toSet = new Set(to.map((a) => a.address.toLowerCase()));
    cc = uniqBy((msg.cc || []).filter((a) => !isOwn(a) && !toSet.has(a.address.toLowerCase())));
  }

  const original = msg.html ? sanitizeHtml(msg.html) : textToHtml(msg.text || '');
  const forward = mode === 'forward';
  const head = forward
    ? `<div>---------- 转发的邮件 ----------<br>发件人：${escapeHtml(addrString(msg.from))}<br>日期：${escapeHtml(formatFullDate(msg.date))}<br>主题：${escapeHtml(msg.subject || '')}<br>收件人：${escapeHtml((msg.to || []).map(addrString).join(', '))}${
        msg.cc?.length ? `<br>抄送：${escapeHtml(msg.cc.map(addrString).join(', '))}` : ''
      }</div><br>`
    : `<div>在 ${escapeHtml(formatFullDate(msg.date))}，${escapeHtml(addrString(msg.from))} 写道：</div>`;
  const quoteHtml = forward
    ? `<br><div class="zm-forward">${head}${original}</div>`
    : `<br><div class="zm-quote">${head}<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${original}</blockquote></div>`;
  const plain = htmlToText(head) + '\n' + (msg.text || htmlToText(msg.html || ''));

  return {
    mode,
    mailboxId,
    to: to.map(addrString).join(', '),
    cc: cc.map(addrString).join(', '),
    bcc: '',
    subject: prefixSubject(forward ? 'Fwd' : 'Re', msg.subject || ''),
    quoteHtml,
    quoteText: plain.slice(0, 4000),
    inReplyTo: forward ? undefined : msg.messageId,
    references: forward ? undefined : [...(msg.references || []), msg.messageId].filter(Boolean).slice(-20),
    replyTo: forward ? undefined : { id: msg.id, threadId: msg.threadId || null },
    sourceId: msg.id,
    forward: forward && msg.attachments?.length ? { id: msg.id, attachments: msg.attachments } : undefined,
    ...extra,
  };
}

/** 把写信状态 + 编辑区内容整理成 /api/send 与 /api/drafts 的 payload */
export function toPayload(state, bodyHtml, fwdAttachments) {
  const quote = state.quoteHtml || '';
  return {
    mailboxId: state.mailboxId,
    to: state.to,
    cc: state.cc,
    bcc: state.bcc,
    subject: state.subject,
    html: `<div style="${BODY_STYLE}">${bodyHtml}</div>${quote}`,
    text: htmlToText(bodyHtml + quote),
    inReplyTo: state.inReplyTo,
    references: state.references,
    replyTo: state.replyTo,
    draftUid: state.draftUid,
    forward: state.forward ? { id: state.forward.id, indexes: (fwdAttachments || state.forward.attachments).map((a) => a.index) } : undefined,
  };
}

export function toForm(payload, files = []) {
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  for (const f of files) fd.append('files', f);
  return fd;
}
