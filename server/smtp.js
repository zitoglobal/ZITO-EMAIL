import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { decrypt } from './security.js';
import * as oauth from './oauth.js';
import { assertSafeMailHost } from './net_guard.js';

async function transport(mb, password) {
  await assertSafeMailHost(mb.smtp_host, 'SMTP');
  let auth;
  if (mb.oauth_refresh_enc || mb.oauth_access_enc) {
    const accessToken = await oauth.ensureAccessToken(mb);
    auth = { type: 'OAuth2', user: mb.login_user || mb.email, accessToken };
  } else {
    auth = { user: mb.login_user || mb.email, pass: password ?? decrypt(mb.pass_enc) };
  }
  return nodemailer.createTransport({
    host: mb.smtp_host,
    port: Number(mb.smtp_port),
    secure: !!mb.smtp_secure,
    requireTLS: !mb.smtp_secure,
    auth,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 90_000,
  });
}

export function friendlySmtpError(e) {
  const raw = [e?.response, e?.message, e?.code].filter(Boolean).join(' ');
  const s = raw.toLowerCase();
  if (e?.code === 'EAUTH' || /\b(535|534)\b|authenticat/.test(s)) return '发信认证失败：请确认已开启 SMTP 服务并使用授权码。';
  if (/enotfound|getaddrinfo/.test(s)) return '无法解析 SMTP 服务器地址。';
  if (/timeout|etimedout/.test(s)) return '连接 SMTP 服务器超时。';
  if (/wrong version|ssl|tls/.test(s)) return 'SMTP 加密方式与端口不匹配（465 端口需开启 SSL，587 端口需关闭 SSL）。';
  if (/\b(550|552|553|554)\b|rejected|spam/.test(s)) return `邮件被服务器拒收：${e?.response || raw}`;
  return raw || '发送失败';
}

export async function verifySmtp(mb, password) {
  try {
    await (await transport(mb, password)).verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlySmtpError(e) };
  }
}

export async function buildRaw(mb, mail) {
  const composer = new MailComposer({
    from: { name: mb.name || '', address: mb.email },
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject || '',
    html: mail.html,
    text: mail.text,
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references?.length ? mail.references : undefined,
    attachments: mail.attachments,
    keepBcc: mail.keepBcc,
    headers: { 'X-Mailer': 'ZITO Smart Mail' },
  });
  return composer.compile().build();
}

const envelopeAddr = (x) => (typeof x === 'string' ? x : x?.address);

export async function sendMail(mb, mail) {
  const all = [mail.to, mail.cc, mail.bcc].flat().filter(Boolean).map(envelopeAddr);
  if (!all.length) throw new Error('请填写收件人');
  const raw = await buildRaw(mb, { ...mail, keepBcc: false });
  try {
    await (await transport(mb)).sendMail({ envelope: { from: mb.email, to: all }, raw });
  } catch (e) {
    throw new Error(friendlySmtpError(e));
  }
  return mail.bcc?.length ? buildRaw(mb, { ...mail, keepBcc: true }) : raw;
}
