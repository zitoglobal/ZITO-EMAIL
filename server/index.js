import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { db, now } from './db.js';
import { detectProvider } from './providers.js';
import { encrypt } from './security.js';
import * as users from './users.js';
import * as repo from './repo.js';
import * as imap from './imap.js';
import * as sync from './sync.js';
import * as mailer from './mailer.js';
import { buildRaw, verifySmtp } from './smtp.js';
import { subscribe, emit, isOnline, onlineUserCount } from './events.js';
import * as ai from './ai.js';
import * as priority from './priority.js';
import * as backup from './backup.js';
import { glossaryHash } from './glossary.js';
import * as labels from './labels.js';
import * as savedSearches from './saved_searches.js';
import * as mailRules from './mail_rules.js';
import * as contacts from './contacts.js';
import * as deals from './deals.js';
import { assertSafeMailHosts } from './net_guard.js';
import { sanitizeMailHtml } from './sanitize_mail.js';
import * as totp from './totp.js';
import * as analytics from './analytics.js';
import * as push from './push.js';
import * as oauth from './oauth.js';
import * as presence from './presence.js';
import * as flagRetry from './flag_retry.js';
import * as adminOps from './admin_ops.js';
import * as teamQueue from './team_queue.js';
import { registerCollabRoutes } from './routes_collab.js';
import { registerDealsRoutes } from './routes_deals.js';
import { registerFocusRoutes } from './routes_focus.js';
import * as aiContext from './ai_context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3310);
const IS_PROD = process.env.NODE_ENV === 'production';
/** 生产默认只绑本机，必须经 Nginx；开发可 BIND_HOST=0.0.0.0 */
const BIND_HOST = process.env.BIND_HOST || (IS_PROD ? '127.0.0.1' : '0.0.0.0');
const COOKIE = 'zm_token';
/** 生产默认 Secure；可用 COOKIE_SECURE=0 显式关闭（仅排查用） */
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === '1' || (IS_PROD && process.env.COOKIE_SECURE !== '0');
const MAX_MAILBOXES = Number(process.env.MAX_MAILBOXES_PER_USER || 20);
const COLORS = ['#0a66ff', '#00b4e6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

// ---------- 工具 ----------
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function apiErrorMessage(e) {
  const raw = e?.message || String(e);
  if (repo.isSqliteCorrupt?.(e) || /malformed|SQLITE_CORRUPT|disk image/i.test(raw)) {
    return '本地邮件索引异常，已尝试自愈，请再删一次；若仍失败请刷新页面';
  }
  return raw;
}

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    if (!e.status) console.error('[api]', req.method, req.path, e.message);
    const body = { error: apiErrorMessage(e) };
    if (e.deal) body.deal = e.deal;
    res.status(e.status || 400).json(body);
  });

/**
 * IMAP 旗标写回失败：
 * - 瞬时/可重试 → 入队，不标邮箱 error
 * - 认证失败 → 标 error，需用户重绑
 */
function softImapFail(mb, e, { folder, uids, flags } = {}) {
  const msg = imap.friendlyImapError(e);
  console.warn('[imap-soft]', mb?.email || mb?.id, msg);
  if (flagRetry.isAuthImapError(e)) {
    if (mb?.id) {
      try {
        repo.setMailboxStatus(mb.id, 'error', msg);
        emit(mb.user_id, 'mailbox', { id: mb.id, status: 'error', error: msg });
        emit(mb.user_id, 'sync', { mailboxId: mb.id, local: true });
      } catch {
        /* ignore */
      }
    }
    return msg;
  }
  if (folder && uids?.length && flags) {
    flagRetry.enqueueFlagRetry(mb, folder, uids, flags);
    return msg;
  }
  return msg;
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const rec = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (rec.length >= max) throw httpError(429, '操作太频繁，请稍后再试');
  rec.push(t);
  buckets.set(key, rec);
}
setInterval(() => buckets.clear(), 3600_000).unref();

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-zm'] !== '1') return res.status(403).json({ error: '非法请求' });
  next();
});

function auth(req, res, next) {
  const u = users.sessionUser(readCookie(req, COOKIE));
  if (!u) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.user = u;
  next();
}

function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

function mailboxOf(req, id) {
  const mb = repo.getMailbox(req.user.id, id || req.params.id || req.body?.mailboxId || req.query.mailboxId);
  if (!mb) throw httpError(404, '邮箱不存在');
  return mb;
}

function messageOf(req, id = req.params.id) {
  const [row] = repo.getMessagesForUser(req.user.id, [Number(id)]);
  if (!row) throw httpError(404, '邮件不存在');
  return row;
}

function signupMode() {
  if (process.env.SIGNUP_CODE) return 'code';
  return process.env.ALLOW_SIGNUP === '1' ? 'open' : 'closed';
}

function folderPublic(f) {
  return { path: f.path, name: f.name, delimiter: f.delimiter, specialUse: f.special_use, total: f.total, unseen: f.unseen, synced: !!f.last_sync };
}

function stateFor(user, dayStart) {
  const mbs = repo.listMailboxes(user.id);
  const settings = users.publicUser(user).settings;
  const focusStats = mbs.length ? priority.focus(user.id, settings, { dayStart }).stats : null;
  // 公海角标：短缓存；无邮箱的管理员也能看团队公海
  let teamStats = null;
  try {
    teamStats = teamQueue.queueStats(user.id);
  } catch (_) {
    teamStats = null;
  }
  return {
    mailboxes: mbs.map(repo.publicMailbox),
    folders: Object.fromEntries(mbs.map((m) => [m.id, repo.listFolders(m.id).map(folderPublic)])),
    counts: { ...repo.counts(user.id), focus: focusStats, team: teamStats },
    labels: labels.listLabels(user.id),
    mailRulesCount: mailRules.listRules(user.id).filter((r) => r.enabled).length,
    savedSearches: savedSearches.listSavedSearches(user.id),
  };
}


// ---------- 健康检查（探针用，无需登录；生产默认精简） ----------
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1 AS ok').get();
    dbOk = true;
  } catch (e) {
    console.error('[health]', e.message);
  }
  const detail =
    process.env.HEALTH_DETAIL === '1' ||
    req.query.detail === '1' ||
    !IS_PROD ||
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1';
  if (!detail) {
    return res.status(dbOk ? 200 : 503).json({ ok: dbOk });
  }
  let errorMailboxes = 0;
  try {
    errorMailboxes = repo.errorMailboxCount();
  } catch (_) {}
  const mailSecret = String(process.env.MAIL_SECRET || '').trim();
  const oauthSt = oauth.status();
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? 'up' : 'down',
    uptime: Math.round(process.uptime()),
    aiConfigured: ai.aiConfigured(),
    mailSecretConfigured: !!(mailSecret && mailSecret !== 'change-me-to-a-long-random-string'),
    lastBackupAt: backup.lastBackupAt(),
    errorMailboxes,
    oauth: { gmail: oauthSt.gmail, microsoft: oauthSt.microsoft },
    onlineUsers: onlineUserCount(),
  });
});

// ---------- 账号 ----------
app.get('/api/auth/status', (req, res) => {
  res.json({ hasUsers: users.userCount() > 0, signup: users.userCount() === 0 ? 'open' : signupMode() });
});

app.post(
  '/api/auth/register',
  wrap(async (req, res) => {
    rateLimit('reg:' + req.ip, 5, 3600_000);
    const first = users.userCount() === 0;
    const mode = signupMode();
    if (!first) {
      if (mode === 'closed') throw httpError(403, '暂未开放注册，请联系管理员开通账号');
      if (mode === 'code' && req.body.code !== process.env.SIGNUP_CODE) throw httpError(403, '邀请码不正确');
    }
    const u = users.createUser({ ...req.body, role: first ? 'admin' : 'member' });
    setCookie(res, users.createSession(u.id, req.headers['user-agent']), users.sessionPolicy().absDays * 24 * 3600);
    res.json({ user: users.publicUser(u) });
  })
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    rateLimit('login:' + req.ip, 10, 10 * 60_000);
    const loginKey = String(req.body?.email || '')
      .trim()
      .toLowerCase()
      .slice(0, 80);
    if (loginKey) rateLimit('login-user:' + loginKey, 8, 15 * 60_000);
    const u = users.authenticate(req.body.email, req.body.password);
    if (!u) throw httpError(401, '账号或密码错误');
    buckets.delete('login:' + req.ip);
    if (totp.isTotpEnabled(u)) {
      const ticket = totp.createLoginTicket(u.id);
      return res.json({ needsTotp: true, ticket });
    }
    setCookie(res, users.createSession(u.id, req.headers['user-agent']), users.sessionPolicy().absDays * 24 * 3600);
    res.json({ user: users.publicUser(u) });
  })
);

app.post(
  '/api/auth/login/totp',
  wrap(async (req, res) => {
    rateLimit('login-totp:' + req.ip, 20, 10 * 60_000);
    const ticketKey = String(req.body?.ticket || '').slice(0, 80);
    if (ticketKey) rateLimit('login-totp-ticket:' + ticketKey, 8, 10 * 60_000);
    const { user: u, via, recoveryLeft } = totp.consumeLoginTicket(req.body?.ticket, req.body?.code);
    setCookie(res, users.createSession(u.id, req.headers['user-agent']), users.sessionPolicy().absDays * 24 * 3600);
    res.json({ user: users.publicUser(u), via, recoveryLeft });
  })
);

app.post('/api/auth/logout', (req, res) => {
  users.destroySession(readCookie(req, COOKIE));
  setCookie(res, '', 0);
  res.json({ ok: true });
});

app.get(
  '/api/me/totp',
  auth,
  wrap(async (req, res) => {
    res.json(totp.userTotpStatus(req.user.id));
  })
);

app.post(
  '/api/me/totp/setup',
  auth,
  wrap(async (req, res) => {
    rateLimit('totp-setup:' + req.user.id, 10, 3600_000);
    const data = await totp.beginSetup(req.user.id, req.user.email);
    res.json(data);
  })
);

app.post(
  '/api/me/totp/confirm',
  auth,
  wrap(async (req, res) => {
    rateLimit('totp-confirm:' + req.user.id, 20, 3600_000);
    res.json(totp.confirmSetup(req.user.id, req.body?.code));
  })
);

app.post(
  '/api/me/totp/disable',
  auth,
  wrap(async (req, res) => {
    rateLimit('totp-disable:' + req.user.id, 10, 3600_000);
    res.json(totp.disable(req.user.id, req.body?.code));
  })
);

app.post(
  '/api/me/totp/recovery',
  auth,
  wrap(async (req, res) => {
    rateLimit('totp-recovery:' + req.user.id, 8, 3600_000);
    res.json(totp.regenerateRecovery(req.user.id, req.body?.code));
  })
);

app.get(
  '/api/me/sessions',
  auth,
  wrap(async (req, res) => {
    res.json({
      sessions: users.listSessions(req.user.id, readCookie(req, COOKIE)),
      policy: users.sessionPolicy(),
    });
  })
);

app.post(
  '/api/me/sessions/revoke-others',
  auth,
  wrap(async (req, res) => {
    const n = users.destroyOtherSessions(req.user.id, readCookie(req, COOKIE));
    res.json({ ok: true, revoked: n });
  })
);

function requireAiCloud(req) {
  if (!ai.aiConfigured()) throw httpError(503, 'AI 未配置：请联系管理员');
  if (users.settingsOf(req.user.id).aiCloudOk === false) {
    throw httpError(403, '已关闭云端 AI：邮件不会外发。可在 设置 → 偏好 中重新开启');
  }
}

app.get(
  '/api/me',
  auth,
  wrap(async (req, res) => {
    const configured = ai.aiConfigured();
    const cloudOk = users.settingsOf(req.user.id).aiCloudOk !== false;
    res.json({
      user: users.publicUser(req.user),
      ai: configured && cloudOk,
      aiMeta: {
        configured,
        cloudOk,
        vendorHost: ai.aiVendorHost(),
        leavesServer: configured && cloudOk,
        models: ai.aiModels(),
        autoRoute: ai.autoRouteEnabled(),
      },
      ...stateFor(req.user, req.query.dayStart),
    });
  })
);

app.get(
  '/api/state',
  auth,
  wrap(async (req, res) => res.json(stateFor(req.user, req.query.dayStart)))
);

// ---------- 今日待办 / 智能分拣 ----------
registerFocusRoutes(app, { auth, wrap, httpError, mailboxOf, priority, labels, users, emit });

/** 团队认领 + 业务阶段（邮箱内，不对接已下线 CRM） */
registerDealsRoutes(app, { auth, wrap, rateLimit, deals, labels, emit, users, push, db, teamQueue });

app.patch(
  '/api/me',
  auth,
  wrap(async (req, res) => {
    users.updateProfile(req.user.id, req.body);
    res.json({ ok: true });
  })
);

app.put(
  '/api/me/settings',
  auth,
  wrap(async (req, res) => res.json({ settings: users.updateSettings(req.user.id, req.body || {}) }))
);

app.post(
  '/api/me/password',
  auth,
  wrap(async (req, res) => {
    rateLimit('pwd:' + req.user.id, 5, 3600_000);
    users.changePassword(req.user.id, req.body.oldPassword, req.body.newPassword, readCookie(req, COOKIE));
    res.json({ ok: true });
  })
);

// ---------- OAuth / 在看 / 团队公海 / 管理员运维（拆路由）----------
registerCollabRoutes(app, {
  auth,
  admin,
  wrap,
  httpError,
  rateLimit,
  oauth,
  presence,
  teamQueue,
  adminOps,
  db,
  repo,
  sync,
  priority,
  emit,
  encrypt,
  assertSafeMailHosts,
  crypto,
  now,
  COLORS,
  MAX_MAILBOXES,
  users,
});

// ---------- 团队管理 ----------
app.get('/api/admin/users', auth, admin, (req, res) => res.json({ users: users.listUsers() }));
app.post(
  '/api/admin/users',
  auth,
  admin,
  wrap(async (req, res) => {
    const u = users.createUser({ ...req.body, role: req.body.role === 'admin' ? 'admin' : 'member' });
    res.json({ user: users.publicUser(u) });
  })
);
app.post(
  '/api/admin/users/:uid/password',
  auth,
  admin,
  wrap(async (req, res) => {
    users.resetPassword(Number(req.params.uid), req.body.password);
    res.json({ ok: true });
  })
);
app.delete(
  '/api/admin/users/:uid',
  auth,
  admin,
  wrap(async (req, res) => {
    const id = Number(req.params.uid);
    if (id === req.user.id) throw httpError(400, '不能删除自己');
    repo.listMailboxes(id).forEach((m) => sync.stop(m.id));
    users.deleteUser(id);
    res.json({ ok: true });
  })
);

// ---------- 邮箱绑定 ----------
app.get(
  '/api/providers/detect',
  auth,
  wrap(async (req, res) => res.json((await detectProvider(req.query.email)) || {}))
);

function connectionFrom(body, detected, existing) {
  const adv = body.advanced || {};
  const pick = (a, b, c) => (a !== undefined && a !== '' && a !== null ? a : b !== undefined && b !== null ? b : c);
  return {
    imap_host: String(pick(adv.imapHost, detected?.imap?.host, existing?.imap_host) || '').trim(),
    imap_port: Number(pick(adv.imapPort, detected?.imap?.port, existing?.imap_port) || 993),
    imap_secure: pick(adv.imapSecure, detected?.imap?.secure, existing ? !!existing.imap_secure : true) ? 1 : 0,
    smtp_host: String(pick(adv.smtpHost, detected?.smtp?.host, existing?.smtp_host) || '').trim(),
    smtp_port: Number(pick(adv.smtpPort, detected?.smtp?.port, existing?.smtp_port) || 465),
    smtp_secure: pick(adv.smtpSecure, detected?.smtp?.secure, existing ? !!existing.smtp_secure : true) ? 1 : 0,
    login_user: String(pick(adv.user, existing?.login_user, body.email) || '').trim(),
  };
}

app.post(
  '/api/mailboxes',
  auth,
  wrap(async (req, res) => {
    rateLimit('bind:' + req.user.id, 15, 10 * 60_000);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, '请输入正确的邮箱地址');
    if (!req.body.password) throw httpError(400, '请输入密码或授权码');
    const existing = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND email = ?').get(req.user.id, email);
    if (!existing && repo.listMailboxes(req.user.id).length >= MAX_MAILBOXES) throw httpError(400, `每个账号最多绑定 ${MAX_MAILBOXES} 个邮箱`);

    const custom = !!req.body.advanced?.imapHost;
    const detected = custom ? null : await detectProvider(email);
    const conn = connectionFrom({ ...req.body, email }, detected, null);
    if (!conn.imap_host || !conn.smtp_host) throw httpError(400, '无法识别邮件服务器，请在高级设置中填写');
    await assertSafeMailHosts(conn);
    const probe = { ...conn, email };

    const [, smtpCheck] = await Promise.all([imap.verifyLogin(probe, req.body.password), verifySmtp(probe, req.body.password)]);

    const count = repo.listMailboxes(req.user.id).length;
    const row = {
      id: existing?.id || crypto.randomBytes(8).toString('hex'),
      user_id: req.user.id,
      email,
      name: String(req.body.name || existing?.name || req.user.name || email.split('@')[0]).trim(),
      color: req.body.color || existing?.color || COLORS[count % COLORS.length],
      provider: custom ? 'custom' : detected?.key || 'custom',
      provider_name: custom ? '自定义邮箱' : detected?.name || '自定义邮箱',
      pass_enc: encrypt(req.body.password),
      auto_saves_sent: !custom && detected?.autoSavesSent ? 1 : 0,
      signature: existing?.signature || '',
      sort: existing?.sort ?? count,
      created_at: existing?.created_at || now(),
      ...conn,
    };
    db.prepare(
      `INSERT INTO mailboxes (id, user_id, email, name, color, provider, provider_name, login_user, pass_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, auto_saves_sent, signature, sort, status, created_at)
       VALUES (@id, @user_id, @email, @name, @color, @provider, @provider_name, @login_user, @pass_enc, @imap_host, @imap_port, @imap_secure,
        @smtp_host, @smtp_port, @smtp_secure, @auto_saves_sent, @signature, @sort, 'syncing', @created_at)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, provider = excluded.provider, provider_name = excluded.provider_name,
        login_user = excluded.login_user, pass_enc = excluded.pass_enc, imap_host = excluded.imap_host, imap_port = excluded.imap_port,
        imap_secure = excluded.imap_secure, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure,
        auto_saves_sent = excluded.auto_saves_sent, status = 'syncing', last_error = NULL`
    ).run(row);
    priority.invalidate(req.user.id);
    sync.restart(row.id);
    res.json({
      mailbox: repo.publicMailbox(repo.getMailboxById(row.id)),
      warning: smtpCheck.ok ? null : `收信正常，但发信校验未通过：${smtpCheck.error}`,
    });
  })
);

app.patch(
  '/api/mailboxes/:id',
  auth,
  wrap(async (req, res) => {
    const mb = mailboxOf(req);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) patch.color = b.color;
    if (b.signature !== undefined) {
      // 富文本签名可含压缩后的 data:image Logo；上限约 400KB 字符
      const sig = String(b.signature);
      if (sig.length > 400_000) throw httpError(400, '签名过大：请压缩 Logo 后再保存（建议宽 < 480px）');
      // 轻量消毒：去掉 script；保留 img data: / https
      patch.signature = sanitizeMailHtml(sig).slice(0, 400_000);
    }

    let reconnect = false;
    if (b.password || b.advanced) {
      const conn = connectionFrom({ ...b, email: mb.email }, null, mb);
      await assertSafeMailHosts(conn);
      const password = b.password || null;
      const probe = { ...mb, ...conn };
      if (password) await imap.verifyLogin(probe, password);
      else await imap.verifyLogin(probe);
      Object.assign(patch, conn);
      if (password) patch.pass_enc = encrypt(password);
      if (b.advanced?.imapHost) Object.assign(patch, { provider: 'custom', provider_name: '自定义邮箱' });
      reconnect = true;
    }
    const cols = Object.keys(patch);
    if (cols.length) {
      db.prepare(`UPDATE mailboxes SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id: mb.id });
    }
    if (reconnect) {
      repo.setMailboxStatus(mb.id, 'syncing');
      sync.restart(mb.id);
    }
    res.json({ mailbox: repo.publicMailbox(repo.getMailboxById(mb.id)) });
  })
);

app.delete(
  '/api/mailboxes/:id',
  auth,
  wrap(async (req, res) => {
    const mb = mailboxOf(req);
    sync.stop(mb.id);
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mb.id);
    priority.invalidate(req.user.id);
    res.json({ ok: true });
  })
);

app.post(
  '/api/mailboxes/order',
  auth,
  wrap(async (req, res) => {
    const st = db.prepare('UPDATE mailboxes SET sort = ? WHERE id = ? AND user_id = ?');
    (req.body.ids || []).forEach((id, i) => st.run(i, id, req.user.id));
    res.json({ ok: true });
  })
);

app.post(
  '/api/mailboxes/:id/sync',
  auth,
  wrap(async (req, res) => {
    const mb = mailboxOf(req);
    const e = sync.ensure(mb.id);
    if (req.body?.folder) await e.syncFolder(req.body.folder);
    else await e.full();
    const row = repo.getMailboxById(mb.id);
    res.json({
      ok: true,
      status: row?.status || 'ok',
      lastSync: row?.last_sync || null,
      lastError: row?.last_error || null,
    });
  })
);

/** 全面同步当前用户全部真实邮箱（跳过 demo），等待完成后返回逐箱状态 */
app.post(
  '/api/sync/all',
  auth,
  wrap(async (req, res) => {
    const list = repo.listMailboxes(req.user.id).filter((m) => m.provider !== 'demo');
    const results = [];
    for (const mb of list) {
      try {
        await sync.ensure(mb.id).full();
        const row = repo.getMailboxById(mb.id);
        results.push({
          id: mb.id,
          email: mb.email,
          status: row?.status || 'ok',
          lastSync: row?.last_sync || null,
          error: row?.last_error || null,
        });
      } catch (e) {
        results.push({ id: mb.id, email: mb.email, status: 'error', lastSync: null, error: e.message || String(e) });
      }
    }
    res.json({ ok: true, results, syncedAt: Date.now() });
  })
);

app.post(
  '/api/mailboxes/:id/folders',
  auth,
  wrap(async (req, res) => {
    const mb = mailboxOf(req);
    const name = String(req.body.name || '').trim();
    if (!name || /[\\*%]/.test(name)) throw httpError(400, '文件夹名称不合法');
    const client = await imap.getClient(mb);
    await client.mailboxCreate(name);
    await sync.ensure(mb.id).full();
    res.json({ ok: true });
  })
);

// ---------- 邮件列表 ----------
app.get(
  '/api/messages',
  auth,
  wrap(async (req, res) => {
    const opts = {
      mailboxId: req.query.mailboxId || 'all',
      box: String(req.query.box || 'inbox'),
      folder: req.query.folder ? String(req.query.folder) : undefined,
      category: req.query.category,
      labelId: req.query.labelId,
      q: String(req.query.q || '').trim(),
      cursor: req.query.cursor,
      limit: Math.min(100, Math.max(10, Number(req.query.limit) || 50)),
    };
    if (opts.box === 'label') {
      const lid = Number(opts.labelId);
      if (!Number.isInteger(lid) || !labels.getLabel(req.user.id, lid)) throw httpError(404, '标签不存在');
    }
    if (opts.box === 'smart') {
      const sid = Number(req.query.smartId);
      if (!Number.isInteger(sid)) throw httpError(400, '缺少智能文件夹');
      const ss = savedSearches.getSavedSearch(req.user.id, sid);
      if (!ss) throw httpError(404, '智能文件夹不存在');
      // 智能文件夹 = 保存的查询；服务端以存档 query 为准，客户端 q 可作覆盖预览
      if (!opts.q) opts.q = ss.query;
    }
    const settings = users.publicUser(req.user).settings;
    opts.map = (rows) => priority.decorate(req.user.id, rows, settings);
    if (opts.mailboxId !== 'all') mailboxOf(req, opts.mailboxId);

    if (req.query.deep === '1' && opts.q) {
      const ids = await deepSearch(req.user.id, opts);
      return res.json({ ...repo.queryMessages(req.user.id, { ids, limit: 200, map: opts.map }), pinned: [], deep: true });
    }

    if (opts.box === 'folder' && opts.mailboxId !== 'all') {
      const f = repo.getFolder(opts.mailboxId, opts.folder);
      if (!f) throw httpError(404, '文件夹不存在');
      if (!f.last_sync) await sync.ensure(opts.mailboxId).syncFolder(opts.folder);
    }

    let result = repo.queryMessages(req.user.id, { ...opts, excludePinned: !opts.q && opts.box === 'inbox' });

    if (!result.nextCursor && !opts.q) {
      const targets = backfillTargets(req.user.id, opts);
      if (targets.length) {
        await Promise.race([
          Promise.allSettled(targets.map((t) => sync.ensure(t.mailbox_id).backfill(t.path))),
          new Promise((r) => setTimeout(r, 20_000)),
        ]);
        result = repo.queryMessages(req.user.id, { ...opts, excludePinned: !opts.q && opts.box === 'inbox' });
      }
    }

    const pinned =
      !opts.cursor && !opts.q && opts.box === 'inbox' ? repo.queryMessages(req.user.id, { ...opts, onlyPinned: true, limit: 50 }).messages : [];
    result.messages = labels.attachLabels(req.user.id, result.messages);
    const pinnedLabeled = labels.attachLabels(req.user.id, pinned);
    res.json({ ...result, pinned: pinnedLabeled });
  })
);

function backfillTargets(userId, opts) {
  const special = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }[opts.box];
  const mbs = opts.mailboxId === 'all' ? repo.listMailboxes(userId) : [repo.getMailbox(userId, opts.mailboxId)];
  const out = [];
  for (const mb of mbs) {
    for (const f of repo.listFolders(mb.id)) {
      const match = opts.box === 'folder' ? f.path === opts.folder : special && f.special_use === special;
      if (match && f.last_sync && f.total > repo.countCached(mb.id, f.path)) out.push(f);
    }
  }
  return out;
}

async function deepSearch(userId, opts) {
  const mbs = opts.mailboxId === 'all' ? repo.listMailboxes(userId) : [repo.getMailbox(userId, opts.mailboxId)];
  const ids = [];
  await Promise.allSettled(
    mbs.map(async (mb) => {
      const folders = repo
        .listFolders(mb.id)
        .filter((f) => (opts.box === 'folder' ? f.path === opts.folder : ['\\Inbox', '\\Sent', '\\Archive'].includes(f.special_use)));
      for (const f of folders) {
        const q = opts.q;
        const uids = (await imap.searchUids(mb, f.path, { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] })).sort((a, b) => b - a).slice(0, 100);
        if (!uids.length) continue;
        const cached = new Set(repo.cachedUids(mb.id, f.path).map((r) => r.uid));
        const missing = uids.filter((u) => !cached.has(u));
        if (missing.length) {
          await imap.withBox(mb, f.path, async (c) => repo.upsertMessages(mb.id, f.path, await imap.fetchEnvelopes(c, missing.join(','), { uid: true })));
        }
        const rows = db
          .prepare(`SELECT id FROM messages WHERE mailbox_id = ? AND folder = ? AND uid IN (${uids.join(',')})`)
          .all(mb.id, f.path);
        ids.push(...rows.map((r) => r.id));
      }
    })
  );
  return ids;
}

// ---------- 邮件详情 ----------
async function loadBody(row, { force = false } = {}) {
  const cached = !force ? repo.getBody(row.id) : null;
  // 旧缓存若仍含未解析 cid:，强制重拉并重写内联图（修复 Content-ID 匹配缺陷）
  if (cached && !/cid:/i.test(cached.html || '') && !/__ZM_CID_\d+__/.test(cached.html || '')) {
    const signals = repo.refreshSignals(row.id, row.subject, cached.text || row.snippet || '');
    const html = imap.resolveCidPlaceholders(cached.html, row.id);
    return { html, text: cached.text, meta: JSON.parse(cached.meta), signals };
  }
  const mb = repo.getMailboxById(row.mailbox_id);
  const parsed = await imap.fetchParsed(mb, row.folder, row.uid);
  const body = imap.serializeParsed(parsed);
  body.html = imap.resolveCidPlaceholders(body.html, row.id, parsed.attachments || []);
  repo.saveBody(row.id, body);
  const signals = repo.refreshSignals(row.id, row.subject, body.text || row.snippet || '');
  return { ...body, signals };
}

function markSeen(row) {
  if (row.seen) return;
  repo.patchMessages([row.id], { seen: 1 });
  db.prepare('UPDATE folders SET unseen = MAX(0, unseen - 1) WHERE mailbox_id = ? AND path = ?').run(row.mailbox_id, row.folder);
  imap.setFlags(repo.getMailboxById(row.mailbox_id), row.folder, [row.uid], { seen: true }).catch(() => {});
}

app.get(
  '/api/messages/:id',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    let body;
    try {
      body = await loadBody(row, { force: req.query.refresh === '1' });
    } catch (e) {
      if (e.status === 404) {
        repo.deleteMessageRows([row.id]);
        throw httpError(404, '这封邮件已在其他客户端被移动或删除');
      }
      throw e;
    }
    // 默认不因 GET 标已读（防链接诱导）；显式 markSeen=1 或 POST /seen
    const shouldMark = req.query.markSeen === '1' || req.query.markSeen === 'true';
    if (shouldMark) markSeen(row);
    const seen = shouldMark ? 1 : row.seen;
    const base = repo.rowToMessage({ ...row, seen, signals: body.signals != null ? body.signals.join(',') : row.signals });
    const [withLabels] = labels.attachLabels(req.user.id, [base]);
    // 允许同源 /api/... 内联图（cid 回退 URL）
    const safeHtml = body.html
      ? sanitizeMailHtml(body.html).replace(
          /src="__ZM_CID_(\d+)__"/g,
          (_, i) => `src="/api/messages/${row.id}/attachments/${i}?inline=1"`
        )
      : body.html;
    res.json({
      ...withLabels,
      ...body.meta,
      html: safeHtml,
      text: body.text,
      signals: body.signals ?? withLabels.signals,
      knownSender: repo.isKnownContact(req.user.id, row.from_addr),
      sender: priority.senderInfo(req.user.id, row.from_addr),
      conflict: priority.conflictHints(req.user.id, { fromAddr: row.from_addr, threadId: row.thread_id }),
      ...(() => {
        const d = deals.lookup(req.user.id, { address: row.from_addr, threadId: row.thread_id });
        return {
          deal: d.deal,
          dealScope: d.scope,
          dealScopes: d.scopes,
          dealStages: d.stages,
          canSplitDeal: !!d.canSplit,
          canClaimPerson: !!d.canClaimPerson,
        };
      })(),
    });
  })
);

app.post(
  '/api/messages/:id/seen',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    markSeen(row);
    res.json({ ok: true, id: row.id, seen: true });
  })
);

app.get(
  '/api/messages/:id/thread',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    res.json({ messages: labels.attachLabels(req.user.id, repo.threadMessages(req.user.id, row).map(repo.rowToMessage)) });
  })
);

app.get(
  '/api/messages/:id/attachments/:index',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    const a = await imap.getAttachment(repo.getMailboxById(row.mailbox_id), row.folder, row.uid, req.params.index);
    const name = a.filename || 'attachment';
    const type = String(a.contentType || 'application/octet-stream').toLowerCase();
    const safeInline = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/.test(type);
    const inline = req.query.inline && safeInline;
    res.setHeader('Content-Type', inline || !type.startsWith('text/') ? type : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (!(inline && type === 'application/pdf')) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(a.content);
  })
);

app.get(
  '/api/messages/:id/raw',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    const mb = repo.getMailboxById(row.mailbox_id);
    const source = await imap.withBox(mb, row.folder, async (c) => (await c.fetchOne(String(row.uid), { source: true }, { uid: true }))?.source);
    if (!source) throw httpError(404, '邮件不存在');
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((row.subject || 'mail').slice(0, 60))}.eml`);
    res.send(source);
  })
);

// ---------- 批量操作 ----------
async function ensureArchiveFolder(mb) {
  const f = repo.specialFolder(mb.id, '\\Archive') || repo.specialFolder(mb.id, '\\All');
  if (f) return f.path;
  const client = await imap.getClient(mb);
  await client.mailboxCreate('Archive').catch(() => {});
  repo.replaceFolders(mb.id, await imap.listServerFolders(mb));
  return repo.specialFolder(mb.id, '\\Archive')?.path || 'Archive';
}

/** 无 \\Trash 映射时创建/补建已删除文件夹，避免误走永久删除 */
async function ensureTrashFolder(mb) {
  const hit = repo.specialFolder(mb.id, '\\Trash');
  if (hit) return hit.path;
  repo.replaceFolders(mb.id, await imap.listServerFolders(mb));
  const afterList = repo.specialFolder(mb.id, '\\Trash');
  if (afterList) return afterList.path;
  const client = await imap.getClient(mb);
  for (const name of ['Trash', 'Deleted', '已删除邮件', '已删除']) {
    try {
      await client.mailboxCreate(name);
      break;
    } catch {
      /* 已存在或服务商不允许 */
    }
  }
  repo.replaceFolders(mb.id, await imap.listServerFolders(mb));
  return repo.specialFolder(mb.id, '\\Trash')?.path || null;
}

async function moveRows(mb, folder, rows, dest) {
  const client = await imap.getClient(mb);
  const lock = await client.getMailboxLock(folder);
  let result;
  try {
    result = await client.messageMove(rows.map((r) => r.uid).join(','), dest, { uid: true });
  } finally {
    lock.release();
  }
  rows.forEach((r) => imap.forgetParsed(mb, folder, r.uid));
  const map = result?.uidMap;
  let mapped = 0;
  for (const r of rows) {
    const nu = map?.get?.(r.uid);
    try {
      if (nu) {
        db.prepare('UPDATE messages SET folder = ?, uid = ?, snooze_until = NULL WHERE id = ?').run(dest, nu, r.id);
        mapped++;
      } else {
        // 无 uidMap（部分服务商）：只改文件夹，UID 待目标夹 sync 对齐，勿删本地行
        db.prepare('UPDATE messages SET folder = ?, snooze_until = NULL WHERE id = ?').run(dest, r.id);
      }
    } catch (e) {
      console.warn('[moveRows]', mb.email, e.message);
    }
  }
  sync.touch(mb.id, folder);
  sync.touch(mb.id, dest);
  return mapped === rows.length;
}

app.post(
  '/api/messages/actions',
  auth,
  wrap(async (req, res) => {
    const { action, dest, until } = req.body || {};
    const rows = repo.getMessagesForUser(req.user.id, (req.body.ids || []).map(Number));
    if (!rows.length) return res.json({ ok: true });
    const ids = rows.map((r) => r.id);

    const groups = new Map();
    for (const r of rows) {
      const k = `${r.mailbox_id}\u0000${r.folder}`;
      if (!groups.has(k)) groups.set(k, { mb: repo.getMailboxById(r.mailbox_id), folder: r.folder, rows: [] });
      groups.get(k).rows.push(r);
    }
    const each = (fn) => Promise.all([...groups.values()].map((g) => fn(g)));
    let undoable = false;
    let followRolled = [];

    switch (action) {
      case 'read':
      case 'unread': {
        const seen = action === 'read';
        repo.patchMessages(ids, { seen: seen ? 1 : 0 });
        await each(async (g) => {
          const uids = g.rows.map((r) => r.uid);
          try {
            await imap.setFlags(g.mb, g.folder, uids, { seen });
            sync.touch(g.mb.id, g.folder);
          } catch (e) {
            softImapFail(g.mb, e, { folder: g.folder, uids, flags: { seen } });
          }
        });
        break;
      }
      case 'flag':
      case 'unflag': {
        const flagged = action === 'flag';
        repo.patchMessages(ids, { flagged: flagged ? 1 : 0 });
        await each(async (g) => {
          const uids = g.rows.map((r) => r.uid);
          try {
            await imap.setFlags(g.mb, g.folder, uids, { flagged });
          } catch (e) {
            softImapFail(g.mb, e, { folder: g.folder, uids, flags: { flagged } });
          }
        });
        break;
      }
      case 'pin':
      case 'unpin':
        repo.patchMessages(ids, { pinned: action === 'pin' ? 1 : 0 });
        break;
      case 'snooze': {
        const t = Number(until);
        if (!t || t < Date.now()) throw httpError(400, '请选择未来的时间');
        repo.patchMessages(ids, { snooze_until: t });
        break;
      }
      case 'unsnooze':
        repo.patchMessages(ids, { snooze_until: null, sort_ts: Date.now() });
        break;
      case 'done':
      case 'undone':
        repo.patchMessages(ids, { done_at: action === 'done' ? Date.now() : null });
        if (action === 'done') {
          try {
            const days = Number(users.settingsOf(req.user.id).followupDays) || 3;
            followRolled = deals.rollFollowAfterHandled(req.user.id, rows, { days, onlyDue: true }) || [];
          } catch {
            /* optional */
          }
        }
        priority.invalidate(req.user.id);
        break;
      case 'nofollow':
      case 'follow':
        repo.patchMessages(ids, { nudge_off: action === 'nofollow' ? 1 : 0 });
        if (action === 'nofollow') {
          try {
            const days = Number(users.settingsOf(req.user.id).followupDays) || 3;
            followRolled = deals.rollFollowAfterHandled(req.user.id, rows, { days, onlyDue: false }) || [];
          } catch {
            /* optional */
          }
        }
        priority.invalidate(req.user.id);
        break;
      case 'archive':
      case 'trash':
      case 'spam':
      case 'notspam':
      case 'move': {
        let all = true;
        await each(async (g) => {
          let target;
          if (action === 'archive') target = await ensureArchiveFolder(g.mb);
          if (action === 'trash') target = await ensureTrashFolder(g.mb);
          if (action === 'spam') target = repo.specialFolder(g.mb.id, '\\Junk')?.path;
          if (action === 'notspam') target = repo.specialFolder(g.mb.id, '\\Inbox')?.path || 'INBOX';
          if (action === 'move') {
            if (!repo.getFolder(g.mb.id, dest)) throw httpError(400, '目标文件夹不存在（不能跨邮箱移动）');
            target = dest;
          }
          // 已在废纸篓：彻底删除；无废纸篓且无法创建：才强制 expunge
          if (action === 'trash' && target && target === g.folder) {
            await imap.expungeMessages(g.mb, g.folder, g.rows.map((r) => r.uid));
            repo.deleteMessageRows(g.rows.map((r) => r.id));
            all = false;
            return;
          }
          if (action === 'trash' && !target) {
            throw httpError(400, '无法定位「已删除」文件夹，请刷新邮箱文件夹后再试；勿静默永久删除');
          }
          if (!target) throw httpError(400, action === 'spam' ? '该邮箱没有垃圾邮件文件夹' : '目标文件夹不存在');
          if (target === g.folder) return;
          const ok = await moveRows(g.mb, g.folder, g.rows, target);
          all = all && ok;
        });
        undoable = all && action !== 'move';
        break;
      }
      case 'delete':
        await each(async (g) => {
          await imap.expungeMessages(g.mb, g.folder, g.rows.map((r) => r.uid));
          repo.deleteMessageRows(g.rows.map((r) => r.id));
        });
        break;
      case 'restore': {
        const back = req.body.origins || {};
        await each(async (g) => {
          const byDest = new Map();
          for (const r of g.rows) {
            const d = back[r.id];
            if (!d || d === g.folder) continue;
            if (!byDest.has(d)) byDest.set(d, []);
            byDest.get(d).push(r);
          }
          for (const [d, rs] of byDest) await moveRows(g.mb, g.folder, rs, d);
        });
        break;
      }
      default:
        throw httpError(400, '未知操作');
    }
    emit(req.user.id, 'sync', { mailboxId: rows[0].mailbox_id, local: true, deal: followRolled.length > 0 });
    res.json({
      ok: true,
      undoable,
      followRolled: followRolled.map((d) => ({
        id: d.id,
        scopeLabel: d.scopeLabel,
        nextFollowAt: d.nextFollowAt,
      })),
    });
  })
);

// ---------- 发送 ----------
function filesFrom(req) {
  return (req.files || []).map((f) => ({
    filename: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    content: f.buffer,
    contentType: f.mimetype,
  }));
}

function outboundClaimMeta(userId, payload) {
  const settings = users.settingsOf(userId);
  const selfEmails = repo
    .listMailboxes(userId)
    .map((m) => m.email)
    .filter(Boolean);
  try {
    return deals.afterOutboundSend(userId, payload, {
      mode: settings.sendAutoClaim === 'off' ? 'off' : 'auto',
      selfEmails,
    });
  } catch (e) {
    console.warn('[deals] after send', e.message);
    return null;
  }
}

app.post(
  '/api/send',
  auth,
  upload.array('files'),
  wrap(async (req, res) => {
    rateLimit('send:' + req.user.id, 60, 10 * 60_000);
    const payload = JSON.parse(req.body.payload || '{}');
    const mb = mailboxOf(req, payload.mailboxId);
    const files = filesFrom(req);
    const recipients = [payload.to, payload.cc, payload.bcc].map(mailer.parseRecipients).flat();
    if (!recipients.length) throw httpError(400, '请填写至少一个有效收件人');

    const delay = Math.min(60, Math.max(0, Number(payload.delaySeconds) || 0)) * 1000;
    const sendAt = payload.sendAt && Number(payload.sendAt) > Date.now() + 5000 ? Number(payload.sendAt) : Date.now() + delay;
    if (sendAt - Date.now() < 1000) {
      await mailer.deliver(mb, payload, files);
      const dealMeta = outboundClaimMeta(req.user.id, payload);
      if (dealMeta?.claimed || dealMeta?.conflict || dealMeta?.stageSuggest) {
        for (const u of users.listUsers()) emit(u.id, 'sync', { local: true, deal: true });
      }
      return res.json({ sent: true, dealMeta });
    }
    const dir = mailer.saveOutboxFiles(files);
    const id = repo.addOutbox(req.user.id, mb.id, payload, dir, sendAt);
    // 撤销窗口（delaySeconds）内不预认领，避免撤销后脏认领；长定时仍入队时认领防撞单
    const undoWindow = !payload.sendAt && delay > 0;
    const dealMeta = undoWindow ? null : outboundClaimMeta(req.user.id, payload);
    if (dealMeta?.claimed || dealMeta?.conflict) {
      for (const u of users.listUsers()) emit(u.id, 'sync', { local: true, deal: true });
    }
    res.json({ outboxId: id, sendAt, scheduled: !!payload.sendAt, dealMeta, undoWindow: !!undoWindow });
  })
);

app.get(
  '/api/outbox',
  auth,
  wrap(async (req, res) => {
    res.json({
      items: repo.listOutbox(req.user.id).map((o) => {
        const p = JSON.parse(o.payload);
        return { id: o.id, mailboxId: o.mailbox_id, to: p.to, subject: p.subject, sendAt: o.send_at, status: o.status, error: o.error, payload: p };
      }),
    });
  })
);

app.delete(
  '/api/outbox/:id',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const o = repo.getOutbox(req.user.id, id);
    if (!o) throw httpError(404, '邮件已发出，无法撤销');
    if (o.status === 'sending') throw httpError(409, '邮件正在发送，无法撤销');
    // scheduled / failed 可取消；sending 与调度器 claim 互斥
    if (!repo.deleteOutboxIfCancellable(id)) {
      const again = repo.getOutbox(req.user.id, id);
      if (!again) throw httpError(404, '邮件已发出，无法撤销');
      if (again.status === 'sending') throw httpError(409, '邮件正在发送，无法撤销');
      throw httpError(409, '无法撤销，请刷新发件箱');
    }
    mailer.removeOutboxFiles(o.files_dir);
    res.json({ ok: true, payload: JSON.parse(o.payload) });
  })
);

app.post(
  '/api/outbox/:id/reschedule',
  auth,
  wrap(async (req, res) => {
    const o = repo.getOutbox(req.user.id, Number(req.params.id));
    if (!o) throw httpError(404, '任务不存在');
    repo.updateOutboxTime(o.id, Math.max(Date.now(), Number(req.body.sendAt) || Date.now()));
    res.json({ ok: true });
  })
);

app.post(
  '/api/drafts',
  auth,
  upload.array('files'),
  wrap(async (req, res) => {
    const payload = JSON.parse(req.body.payload || '{}');
    const mb = mailboxOf(req, payload.mailboxId);
    const drafts = repo.specialFolder(mb.id, '\\Drafts');
    if (!drafts) throw httpError(400, '该邮箱没有草稿箱');
    const mail = await mailer.buildMail(mb, payload, filesFrom(req));
    const raw = await buildRaw(mb, { ...mail, keepBcc: true });
    const result = await imap.appendMessage(mb, drafts.path, raw, ['\\Draft', '\\Seen']);
    if (payload.draftUid && Number(payload.draftUid) !== result?.uid) {
      await imap.expungeMessages(mb, drafts.path, [Number(payload.draftUid)]).catch(() => {});
    }
    sync.forceSync(mb.id, drafts.path).catch(() => {});
    sync.touch(mb.id, drafts.path, 800);
    res.json({ ok: true, uid: result?.uid || null });
  })
);

app.post(
  '/api/drafts/discard',
  auth,
  wrap(async (req, res) => {
    const mb = mailboxOf(req, req.body.mailboxId);
    const drafts = repo.specialFolder(mb.id, '\\Drafts');
    const uid = Number(req.body.uid);
    if (drafts && uid) {
      await imap.expungeMessages(mb, drafts.path, [uid]);
      repo.deleteUids(mb.id, drafts.path, [uid]);
      sync.touch(mb.id, drafts.path);
    }
    res.json({ ok: true });
  })
);

// ---------- 联系人 / 模板 ----------

// ---------- 用户标签（切片 A） ----------
app.get('/api/labels', auth, (req, res) => res.json({ labels: labels.listLabels(req.user.id), colors: labels.LABEL_COLORS, presets: labels.TRADE_LABEL_PRESETS }));

app.post(
  '/api/labels',
  auth,
  wrap(async (req, res) => {
    const row = labels.createLabel(req.user.id, req.body || {});
    emit(req.user.id, 'labels', { action: 'create', id: row.id });
    res.json({ label: row, labels: labels.listLabels(req.user.id) });
  })
);

app.put(
  '/api/labels/reorder',
  auth,
  wrap(async (req, res) => {
    const list = labels.reorderLabels(req.user.id, req.body?.ids || []);
    res.json({ labels: list });
  })
);

app.post(
  '/api/labels/presets',
  auth,
  wrap(async (req, res) => {
    const result = labels.applyTradePresets(req.user.id);
    emit(req.user.id, 'labels', { action: 'presets' });
    res.json(result);
  })
);

app.patch(
  '/api/labels/:id',
  auth,
  wrap(async (req, res) => {
    const row = labels.updateLabel(req.user.id, Number(req.params.id), req.body || {});
    emit(req.user.id, 'labels', { action: 'update', id: row.id });
    res.json({ label: row, labels: labels.listLabels(req.user.id) });
  })
);

app.delete(
  '/api/labels/:id',
  auth,
  wrap(async (req, res) => {
    labels.deleteLabel(req.user.id, Number(req.params.id));
    emit(req.user.id, 'labels', { action: 'delete', id: Number(req.params.id) });
    res.json({ ok: true, labels: labels.listLabels(req.user.id) });
  })
);

app.post(
  '/api/messages/labels',
  auth,
  wrap(async (req, res) => {
    const { ids, add, remove } = req.body || {};
    const result = labels.setMessageLabels(req.user.id, ids || [], { add: add || [], remove: remove || [] });
    emit(req.user.id, 'sync', { local: true, labels: true });
    res.json(result);
  })
);

// ---------- 保存的搜索 / 智能文件夹（切片 B） ----------
app.get('/api/saved-searches', auth, (req, res) =>
  res.json({ savedSearches: savedSearches.listSavedSearches(req.user.id), presets: savedSearches.TRADE_SEARCH_PRESETS })
);

app.post(
  '/api/saved-searches',
  auth,
  wrap(async (req, res) => {
    const row = savedSearches.createSavedSearch(req.user.id, req.body || {});
    emit(req.user.id, 'saved-searches', { action: 'create', id: row.id });
    res.json({ savedSearch: row, savedSearches: savedSearches.listSavedSearches(req.user.id) });
  })
);

app.put(
  '/api/saved-searches/reorder',
  auth,
  wrap(async (req, res) => {
    const list = savedSearches.reorderSavedSearches(req.user.id, req.body?.ids || []);
    res.json({ savedSearches: list });
  })
);

app.post(
  '/api/saved-searches/presets',
  auth,
  wrap(async (req, res) => {
    const result = savedSearches.applyTradePresets(req.user.id);
    emit(req.user.id, 'saved-searches', { action: 'presets' });
    res.json(result);
  })
);

app.patch(
  '/api/saved-searches/:id',
  auth,
  wrap(async (req, res) => {
    const row = savedSearches.updateSavedSearch(req.user.id, Number(req.params.id), req.body || {});
    emit(req.user.id, 'saved-searches', { action: 'update', id: row.id });
    res.json({ savedSearch: row, savedSearches: savedSearches.listSavedSearches(req.user.id) });
  })
);

app.delete(
  '/api/saved-searches/:id',
  auth,
  wrap(async (req, res) => {
    savedSearches.deleteSavedSearch(req.user.id, Number(req.params.id));
    emit(req.user.id, 'saved-searches', { action: 'delete', id: Number(req.params.id) });
    res.json({ ok: true, savedSearches: savedSearches.listSavedSearches(req.user.id) });
  })
);


// ---------- 邮件规则（切片 C） ----------
app.get('/api/mail-rules', auth, (req, res) =>
  res.json({
    rules: mailRules.listRules(req.user.id),
    conditionFields: mailRules.CONDITION_FIELD_OPTIONS,
    actionTypes: mailRules.ACTION_TYPE_OPTIONS,
  })
);

app.post(
  '/api/mail-rules',
  auth,
  wrap(async (req, res) => {
    const row = mailRules.createRule(req.user.id, req.body || {});
    emit(req.user.id, 'mail-rules', { action: 'create', id: row.id });
    res.json({ rule: row, rules: mailRules.listRules(req.user.id) });
  })
);

app.put(
  '/api/mail-rules/reorder',
  auth,
  wrap(async (req, res) => {
    const list = mailRules.reorderRules(req.user.id, req.body?.ids || []);
    res.json({ rules: list });
  })
);

app.patch(
  '/api/mail-rules/:id',
  auth,
  wrap(async (req, res) => {
    const row = mailRules.updateRule(req.user.id, Number(req.params.id), req.body || {});
    emit(req.user.id, 'mail-rules', { action: 'update', id: row.id });
    res.json({ rule: row, rules: mailRules.listRules(req.user.id) });
  })
);

app.delete(
  '/api/mail-rules/:id',
  auth,
  wrap(async (req, res) => {
    mailRules.deleteRule(req.user.id, Number(req.params.id));
    emit(req.user.id, 'mail-rules', { action: 'delete', id: Number(req.params.id) });
    res.json({ ok: true, rules: mailRules.listRules(req.user.id) });
  })
);

app.get('/api/contacts', auth, (req, res) => res.json({ contacts: repo.searchContacts(req.user.id, String(req.query.q || '').trim()) }));

// ---------- 联系人 / 客户主数据（切片 D） ----------
app.get(
  '/api/contact-persons',
  auth,
  wrap(async (req, res) => {
    const data = contacts.listPersons(req.user.id, {
      q: String(req.query.q || '').trim(),
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(data);
  })
);

app.get(
  '/api/contact-persons/resolve',
  auth,
  wrap(async (req, res) => {
    const address = String(req.query.address || '').trim();
    const data = contacts.resolveByAddress(req.user.id, address);
    if (data.person) {
      data.recent = contacts.recentForPerson(req.user.id, data.person.id, 5);
    } else {
      data.recent = [];
    }
    res.json(data);
  })
);

app.get(
  '/api/contact-persons/:id',
  auth,
  wrap(async (req, res) => {
    const person = contacts.getPerson(req.user.id, Number(req.params.id));
    if (!person) throw httpError(404, '联系人不存在');
    const recent = contacts.recentForPerson(req.user.id, person.id, 8);
    res.json({ person, recent });
  })
);

app.post(
  '/api/contact-persons',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.createPerson(req.user.id, req.body || {});
      emit(req.user.id, 'contacts', { action: 'create', id: person.id });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.patch(
  '/api/contact-persons/:id',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.updatePerson(req.user.id, Number(req.params.id), req.body || {});
      emit(req.user.id, 'contacts', { action: 'update', id: person.id });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.delete(
  '/api/contact-persons/:id',
  auth,
  wrap(async (req, res) => {
    try {
      contacts.deletePerson(req.user.id, Number(req.params.id));
      emit(req.user.id, 'contacts', { action: 'delete', id: Number(req.params.id) });
      res.json({ ok: true });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.post(
  '/api/contact-persons/merge',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.mergePersons(req.user.id, req.body?.fromId, req.body?.toId);
      emit(req.user.id, 'contacts', { action: 'merge', id: person.id });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.post(
  '/api/contact-persons/:id/addresses',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.addAddress(req.user.id, Number(req.params.id), req.body?.address, {
        makePrimary: !!req.body?.makePrimary,
      });
      emit(req.user.id, 'contacts', { action: 'address', id: person.id });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.delete(
  '/api/contact-persons/:id/addresses/:addr',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.removeAddress(req.user.id, Number(req.params.id), decodeURIComponent(req.params.addr));
      emit(req.user.id, 'contacts', { action: 'address', id: person.id });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.post(
  '/api/contact-persons/:id/primary',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.setPrimaryAddress(req.user.id, Number(req.params.id), req.body?.address);
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.post(
  '/api/contact-persons/:id/tags',
  auth,
  wrap(async (req, res) => {
    try {
      const person = contacts.setPersonTags(req.user.id, Number(req.params.id), {
        add: req.body?.add || [],
        remove: req.body?.remove || [],
      });
      res.json({ person });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.get('/api/contact-tags', auth, (req, res) =>
  res.json({ tags: contacts.listContactTags(req.user.id), colors: contacts.CONTACT_TAG_COLORS, presets: contacts.TRADE_CONTACT_TAG_PRESETS })
);

app.post(
  '/api/contact-tags',
  auth,
  wrap(async (req, res) => {
    try {
      const tag = contacts.createContactTag(req.user.id, req.body || {});
      res.json({ tag, tags: contacts.listContactTags(req.user.id) });
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.delete(
  '/api/contact-tags/:id',
  auth,
  wrap(async (req, res) => {
    try {
      const result = contacts.deleteContactTag(req.user.id, Number(req.params.id));
      res.json(result);
    } catch (e) {
      if (e.status) throw httpError(e.status, e.message);
      throw e;
    }
  })
);

app.post(
  '/api/contact-tags/presets',
  auth,
  wrap(async (req, res) => {
    const result = contacts.applyContactTagPresets(req.user.id);
    res.json(result);
  })
);


app.get('/api/templates', auth, (req, res) => res.json({ templates: repo.listTemplates(req.user.id) }));
app.post(
  '/api/templates',
  auth,
  wrap(async (req, res) => res.json({ id: repo.saveTemplate(req.user.id, req.body || {}) }))
);
app.delete('/api/templates/:tid', auth, (req, res) => {
  repo.deleteTemplate(req.user.id, Number(req.params.tid));
  res.json({ ok: true });
});

// ---------- AI ----------
async function mailForAi(req, id) {
  const row = messageOf(req, id);
  const body = await loadBody(row);
  const thread = repo.threadMessages(req.user.id, row).filter((m) => m.id !== row.id).slice(-3);
  return {
    subject: row.subject,
    from: { name: row.from_name, address: row.from_addr },
    date: new Date(row.date).toISOString(),
    text: body.text || String(body.html || '').replace(/<[^>]+>/g, ' '),
    history: thread.map((t) => `${t.from_name || t.from_addr}（${new Date(t.date).toLocaleDateString('zh-CN')}）：${t.snippet}`),
  };
}

const aiLimit = (req) => rateLimit('ai:' + req.user.id, 60, 10 * 60_000);

app.post(
  '/api/ai/summarize',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    res.json(await ai.summarize(await mailForAi(req, req.body.id)));
  })
);
app.post(
  '/api/ai/translate',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    const target = req.body.target || settings.translateTarget || '简体中文';
    const row = messageOf(req, req.body.id);
    const gHash = glossaryHash(settings.glossary);
    const cached = repo.getTranslateCache(row.id, target, gHash);
    if (cached) {
      return res.json({
        subject: cached.subject,
        body: cached.body,
        sourceLang: cached.sourceLang,
        fromCache: true,
      });
    }
    const out = await ai.translate(await mailForAi(req, req.body.id), target, settings.glossary);
    try {
      repo.setTranslateCache(row.id, target, gHash, out);
    } catch (_) {}
    res.json({ ...out, fromCache: false });
  })
);
app.post(
  '/api/ai/reply',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    const row = messageOf(req, req.body.id);
    const biz = aiContext.bizContextForRow(req.user.id, row, settings);
    res.json(
      await ai.draftReply(await mailForAi(req, req.body.id), {
        ...req.body,
        glossary: settings.glossary,
        bizContext: aiContext.formatBizContext(biz),
      })
    );
  })
);
app.post(
  '/api/ai/compose',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    res.json(await ai.compose({ ...req.body, glossary: settings.glossary }));
  })
);
app.post(
  '/api/ai/rewrite',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    if (!String(req.body.text || '').trim()) throw httpError(400, '请先输入需要处理的内容');
    const settings = users.settingsOf(req.user.id);
    res.json(await ai.rewrite(req.body.text, req.body.mode, settings.glossary));
  })
);
app.post(
  '/api/ai/digest',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    const focus = priority.focus(req.user.id, settings, { dayStart: req.body.dayStart });
    const reply = (focus.reply || []).slice(0, 22);
    const follow = (focus.followups || []).slice(0, 10);
    const seen = new Set([...reply, ...follow].map((m) => m.id));
    // 少量未读补漏（跳过通知/订阅噪音），避免简报完全错过「未进 Focus 的 VIP」
    const { messages: unreadRaw } = repo.queryMessages(req.user.id, {
      mailboxId: req.body.mailboxId || 'all',
      box: 'unread',
      limit: 30,
    });
    const unreadExtra = unreadRaw
      .filter((m) => !seen.has(m.id) && (m.category === 'people' || m.tier === 'vip' || m.flagged))
      .slice(0, 8);
    const items = [
      ...reply.map((m) => ({ ...m, uid: m.id, digestKind: 'need_reply' })),
      ...follow.map((m) => ({ ...m, uid: m.id, digestKind: 'waiting' })),
      ...unreadExtra.map((m) => ({ ...m, uid: m.id, digestKind: 'unread' })),
    ];
    if (!items.length) {
      return res.json({
        overview: '今日待办与等待都空着，也没有需要优先看的未读客户信。',
        priorities: [],
        groups: [],
        source: 'focus',
      });
    }
    const result = await ai.digest(items);
    const byId = new Map(items.map((m) => [m.id, m]));
    const pick = (id) => {
      const m = byId.get(Number(id));
      return m ? { id: m.id, subject: m.subject, from: m.from, mailboxId: m.mailboxId } : null;
    };
    res.json({
      overview: result.overview,
      priorities: (result.priorities || []).map((p) => ({ ...p, mail: pick(p.uid) })).filter((p) => p.mail),
      groups: (result.groups || []).map((g) => ({ ...g, mails: (g.uids || []).map(pick).filter(Boolean) })),
      source: 'focus',
      stats: {
        needReply: reply.length,
        waiting: follow.length,
        unreadExtra: unreadExtra.length,
        overdue: focus.stats?.overdue || 0,
      },
    });
  })
);

app.post(
  '/api/ai/note',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req, req.body.id);
    if (req.body.clear) {
      db.prepare('UPDATE messages SET ai_note = NULL WHERE id = ?').run(row.id);
      return res.json({ ok: true, aiNote: null });
    }
    const summaryText = String(req.body.summary || req.body.note || '').trim();
    if (!summaryText) throw httpError(400, '缺少摘要内容');
    const note = String(req.body.note || summaryText).trim().slice(0, 120);
    const payload = {
      note,
      urgency: ['high', 'medium', 'low'].includes(req.body.urgency) ? req.body.urgency : 'medium',
      at: Date.now(),
      pinned: true,
      source: String(req.body.source || 'summarize').slice(0, 32),
    };
    if (req.body.summary) payload.summary = String(req.body.summary).slice(0, 2000);
    if (Array.isArray(req.body.keyPoints)) payload.keyPoints = req.body.keyPoints.map((x) => String(x).slice(0, 200)).slice(0, 8);
    if (Array.isArray(req.body.actionItems)) payload.actionItems = req.body.actionItems.map((x) => String(x).slice(0, 200)).slice(0, 8);
    if (req.body.category) payload.category = String(req.body.category).slice(0, 40);
    if (Array.isArray(req.body.quickReplies)) payload.quickReplies = req.body.quickReplies.map((x) => String(x).slice(0, 120)).slice(0, 5);
    if (req.body.replyLanguage) payload.replyLanguage = String(req.body.replyLanguage).slice(0, 40);
    db.prepare('UPDATE messages SET ai_note = ? WHERE id = ?').run(JSON.stringify(payload), row.id);
    res.json({ ok: true, aiNote: payload });
  })
);

app.post(
  '/api/ai/triage',
  auth,
  wrap(async (req, res) => {
    requireAiCloud(req);
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    // 批量过大 + 思考模型易超时；默认最多 12 封
    const rows = repo.getMessagesForUser(req.user.id, (req.body.ids || []).slice(0, 12).map(Number));
    const todo = rows.filter((r) => !r.ai_note || req.body.force);
    if (todo.length) {
      const payload = todo.map((r) => {
        const biz = aiContext.bizContextForRow(req.user.id, r, settings);
        // 优先用已缓存正文前段，避免分诊只看 snippet 导致建议偏浅
        let bodyExcerpt = '';
        try {
          const cached = repo.getBody(r.id);
          bodyExcerpt = String(cached?.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500);
        } catch (_) {}
        return {
          uid: r.id,
          from: { name: r.from_name, address: r.from_addr },
          subject: r.subject,
          snippet: r.snippet,
          bodyExcerpt: bodyExcerpt || r.snippet || '',
          context: aiContext.triageContextLine(biz),
          _biz: biz,
        };
      });
      const result = await ai.triage(payload.map(({ _biz, ...m }) => m));
      const st = db.prepare('UPDATE messages SET ai_note = ? WHERE id = ?');
      for (const it of result.items || []) {
        const row = todo.find((r) => r.id === Number(it.uid));
        const packed = payload.find((p) => p.uid === Number(it.uid));
        if (row && it.note) {
          const actions = aiContext.normalizeTriageActions(it.actions, packed?._biz || {});
          st.run(
            JSON.stringify({
              note: String(it.note).slice(0, 120),
              urgency: ['high', 'medium', 'low'].includes(it.urgency) ? it.urgency : 'medium',
              actions,
              at: Date.now(),
              source: 'triage',
            }),
            row.id
          );
        }
      }
    }
    const notes = repo
      .getMessagesForUser(
        req.user.id,
        rows.map((r) => r.id)
      )
      .map((r) => [r.id, r.ai_note ? JSON.parse(r.ai_note) : null]);
    res.json({ notes: Object.fromEntries(notes) });
  })
);

// ---------- 实时事件 ----------
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const off = subscribe(req.user.id, res);
  const user = req.user;
  const t = setTimeout(() => remindUser(user), 8000);
  req.on('close', () => {
    clearTimeout(t);
    off();
  });
});

app.get(
  '/api/insights',
  auth,
  wrap(async (req, res) => {
    res.json(analytics.teamInsights(req.user.id, { dayStart: req.query.dayStart }));
  })
);

app.get('/api/push/vapid', auth, (_req, res) => res.json({ publicKey: push.publicKey() }));
app.post(
  '/api/push/subscribe',
  auth,
  wrap(async (req, res) => {
    res.json(push.saveSubscription(req.user.id, req.body?.subscription || req.body, req.headers['user-agent']));
  })
);
app.post(
  '/api/push/unsubscribe',
  auth,
  wrap(async (req, res) => {
    res.json(push.removeSubscription(req.user.id, req.body?.endpoint));
  })
);
app.get(
  '/api/push/status',
  auth,
  wrap(async (req, res) => {
    res.json({ subscriptions: push.listForUser(req.user.id), publicKey: push.publicKey() });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// ---------- 前端静态资源 ----------
const DIST = path.resolve(__dirname, '../dist');
if (fs.existsSync(DIST)) {
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: https:",
    "connect-src 'self'",
    "frame-src 'self' blob: data:",
    "worker-src 'self'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
  app.use('/assets', express.static(path.join(DIST, 'assets'), { maxAge: '365d', immutable: true }));
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', CSP);
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

repo.backfillSignals();
try {
  repo.ensureFtsHealthy();
  repo.backfillFts();
} catch (e) {
  console.warn('[fts]', e.message);
  try {
    if (repo.isSqliteCorrupt(e)) repo.rebuildFtsIndex();
  } catch (e2) {
    console.error('[fts] recovery failed', e2.message);
  }
}
mailer.startScheduler();
flagRetry.startFlagRetryScheduler();
sync.startAll();
backup.startBackupScheduler();

/** 客户邮件超过回复时限仍未处理时分阶段提醒（冷却后升级，最多 3 级） */
function remindUser(u) {
  const settings = users.publicUser(u).settings;
  if (!settings.remindOverdue || !repo.listMailboxes(u.id).length) return;
  try {
    const r = priority.overdueToRemind(u.id, settings);
    if (r) {
      if (isOnline(u.id)) emit(u.id, 'remind', r);
      if (settings.notify) {
        push
          .notifyUser(u.id, {
            title: r.escalate ? '超时升级提醒' : '客户邮件待回复',
            body: r.subject || `${r.count || ''} 封待处理`,
            url: '/',
            tag: 'zm-remind',
          })
          .catch(() => {});
      }
    }
  } catch (e) {
    console.error('[remind]', e.message);
  }
}
const remindOverdue = () => {
  db.prepare('SELECT * FROM users').all().forEach(remindUser);
  try {
    teamQueue.remindAdmins({ emit, push, isOnline });
  } catch (e) {
    console.error('[remind-queue]', e.message);
  }
};
setTimeout(remindOverdue, 60_000).unref();
setInterval(remindOverdue, 10 * 60_000).unref();
const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`[zito-mail] 服务已启动 http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${PORT} (bind ${BIND_HOST})`);
  try {
    oauth.logStartupHints();
  } catch (_) {}
});

function shutdown(signal) {
  console.log(`[zito-mail] 收到 ${signal}，正在关闭…`);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_) {}
    try {
      db.close();
    } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
