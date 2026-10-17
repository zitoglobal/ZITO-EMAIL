/**
 * Gmail / Microsoft 365 OAuth2（IMAP XOAUTH2）。
 * 未配置 CLIENT_ID/SECRET 时接口返回 enabled:false，不影响密码绑定。
 */
import { encrypt, decrypt } from './security.js';
import { db, now } from './db.js';
import crypto from 'node:crypto';

const BASE = () => String(process.env.PUBLIC_BASE_URL || process.env.OAUTH_PUBLIC_BASE || '').replace(/\/+$/, '');

export function status() {
  const gmail = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  const microsoft = !!(process.env.MS_OAUTH_CLIENT_ID && process.env.MS_OAUTH_CLIENT_SECRET);
  const publicBase = BASE() || null;
  const missing = [];
  if (!publicBase && (gmail || microsoft || process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.MS_OAUTH_CLIENT_ID)) {
    missing.push('PUBLIC_BASE_URL');
  }
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && !process.env.GOOGLE_OAUTH_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (process.env.MS_OAUTH_CLIENT_ID && !process.env.MS_OAUTH_CLIENT_SECRET) missing.push('MS_OAUTH_CLIENT_SECRET');
  return {
    gmail,
    microsoft,
    publicBase,
    ready: (gmail || microsoft) && !!publicBase && missing.length === 0,
    missing,
    redirects: {
      gmail: gmail || process.env.GOOGLE_OAUTH_CLIENT_ID ? (process.env.GOOGLE_OAUTH_REDIRECT || (publicBase ? `${publicBase}/api/oauth/gmail/callback` : null)) : null,
      microsoft:
        microsoft || process.env.MS_OAUTH_CLIENT_ID
          ? process.env.MS_OAUTH_REDIRECT || (publicBase ? `${publicBase}/api/oauth/microsoft/callback` : null)
          : null,
    },
    docs: '/docs/oauth-setup.md',
  };
}

/** 启动时打印一次配置缺口（不抛错，密码绑定仍可用） */
export function logStartupHints() {
  const st = status();
  if (st.ready) {
    console.log(`[oauth] 已就绪：Gmail=${st.gmail} Microsoft=${st.microsoft} base=${st.publicBase}`);
    return;
  }
  if (st.gmail || st.microsoft || st.missing.length) {
    console.warn(`[oauth] 未完全就绪：${st.missing.length ? `缺少 ${st.missing.join(', ')}` : '需 PUBLIC_BASE_URL + Client ID/Secret'}；详见 docs/oauth-setup.md`);
  }
}

function redirectUri(provider) {
  const configured =
    provider === 'gmail'
      ? process.env.GOOGLE_OAUTH_REDIRECT
      : process.env.MS_OAUTH_REDIRECT;
  if (configured) return configured;
  const base = BASE();
  if (!base) throw new Error('请配置 PUBLIC_BASE_URL 或对应 OAUTH_REDIRECT');
  return `${base}/api/oauth/${provider}/callback`;
}

/** 短时 state → userId（防 CSRF） */
const states = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of states) if (t - v.at > 15 * 60_000) states.delete(k);
}, 60_000).unref();

export function beginAuth(provider, userId, opts = {}) {
  const st = status();
  if (provider === 'gmail' && !st.gmail) throw Object.assign(new Error('未配置 Google OAuth（GOOGLE_OAUTH_CLIENT_ID/SECRET）'), { status: 503 });
  if (provider === 'microsoft' && !st.microsoft) throw Object.assign(new Error('未配置 Microsoft OAuth（MS_OAUTH_CLIENT_ID/SECRET）'), { status: 503 });
  const state = crypto.randomBytes(24).toString('hex');
  states.set(state, {
    userId,
    provider,
    at: Date.now(),
    mailboxId: opts.mailboxId ? String(opts.mailboxId) : null,
  });

  if (provider === 'gmail') {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', process.env.GOOGLE_OAUTH_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri('gmail'));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'https://mail.google.com/ openid email profile');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return { url: u.toString(), state };
  }

  const tenant = process.env.MS_OAUTH_TENANT || 'common';
  const u = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', process.env.MS_OAUTH_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri('microsoft'));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set(
    'scope',
    'offline_access openid email profile User.Read https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
  );
  u.searchParams.set('state', state);
  return { url: u.toString(), state };
}

async function exchangeGmail(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri('gmail'),
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google 换票失败');
  const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.json());
  if (!me.email) throw new Error('未能读取 Google 账号邮箱');
  return {
    email: String(me.email).toLowerCase(),
    name: me.name || me.email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600,
    provider: 'gmail',
    providerName: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    autoSavesSent: true,
  };
}

async function exchangeMicrosoft(code) {
  const tenant = process.env.MS_OAUTH_TENANT || 'common';
  const body = new URLSearchParams({
    code,
    client_id: process.env.MS_OAUTH_CLIENT_ID,
    client_secret: process.env.MS_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri('microsoft'),
    grant_type: 'authorization_code',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Microsoft 换票失败');
  let email = '';
  let name = '';
  try {
    const me = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    }).then((r) => r.json());
    email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    name = me.displayName || '';
  } catch {
    /* Graph 可选；再从 id_token 取 */
  }
  if (!email.includes('@') && data.id_token) {
    try {
      const part = String(data.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
      email = String(payload.email || payload.preferred_username || payload.upn || '').toLowerCase();
      name = name || payload.name || '';
    } catch {
      /* ignore */
    }
  }
  if (!email.includes('@')) throw new Error('未能读取 Microsoft 账号邮箱');
  return {
    email,
    name: name || email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600,
    provider: 'outlook',
    providerName: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    autoSavesSent: true,
  };
}

export async function finishAuth(provider, { code, state }) {
  const meta = states.get(String(state || ''));
  states.delete(String(state || ''));
  if (!meta || meta.provider !== provider) throw Object.assign(new Error('OAuth state 无效或已过期，请重试'), { status: 400 });
  if (!code) throw Object.assign(new Error('缺少授权码'), { status: 400 });
  const profile = provider === 'gmail' ? await exchangeGmail(code) : await exchangeMicrosoft(code);
  return { userId: meta.userId, profile, mailboxId: meta.mailboxId || null };
}

async function refreshGmail(refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Google 刷新令牌失败');
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
}

async function refreshMicrosoft(refreshToken) {
  const tenant = process.env.MS_OAUTH_TENANT || 'common';
  const body = new URLSearchParams({
    client_id: process.env.MS_OAUTH_CLIENT_ID,
    client_secret: process.env.MS_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Microsoft 刷新令牌失败');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600,
  };
}

/** 确保邮箱行有可用 access token（必要时刷新并写回） */
export async function ensureAccessToken(mb) {
  if (!mb?.oauth_refresh_enc && !mb?.oauth_access_enc) return null;
  const exp = Number(mb.oauth_expiry) || 0;
  if (mb.oauth_access_enc && exp > Date.now() + 60_000) {
    return decrypt(mb.oauth_access_enc);
  }
  if (!mb.oauth_refresh_enc) throw new Error('OAuth 已失效，请重新授权绑定');
  const refresh = decrypt(mb.oauth_refresh_enc);
  const kind = mb.oauth_provider === 'microsoft' || mb.provider === 'outlook' ? 'microsoft' : 'gmail';
  const next = kind === 'microsoft' ? await refreshMicrosoft(refresh) : await refreshGmail(refresh);
  const t = now();
  db.prepare(
    `UPDATE mailboxes SET oauth_access_enc = ?, oauth_expiry = ?, oauth_refresh_enc = COALESCE(?, oauth_refresh_enc) WHERE id = ?`
  ).run(
    encrypt(next.accessToken),
    t + next.expiresIn * 1000,
    next.refreshToken ? encrypt(next.refreshToken) : null,
    mb.id
  );
  return next.accessToken;
}

export function storeTokens(mailboxId, profile) {
  const t = now();
  const refreshEnc = profile.refreshToken ? encrypt(profile.refreshToken) : null;
  if (!refreshEnc && !profile.accessToken) throw new Error('未获得 refresh_token，请重新授权并勾选离线访问');
  db.prepare(
    `UPDATE mailboxes SET
       oauth_provider = ?, oauth_access_enc = ?, oauth_refresh_enc = COALESCE(?, oauth_refresh_enc),
       oauth_expiry = ?, pass_enc = ?
     WHERE id = ?`
  ).run(
    profile.provider === 'outlook' ? 'microsoft' : 'gmail',
    encrypt(profile.accessToken),
    refreshEnc,
    t + (profile.expiresIn || 3600) * 1000,
    encrypt('oauth'),
    mailboxId
  );
}
