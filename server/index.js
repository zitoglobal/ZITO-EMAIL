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
import { subscribe, emit, isOnline } from './events.js';
import * as ai from './ai.js';
import * as priority from './priority.js';
import * as backup from './backup.js';
import { glossaryHash } from './glossary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3310);
const COOKIE = 'zm_token';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
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

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    if (!e.status) console.error('[api]', req.method, req.path, e.message);
    res.status(e.status || 400).json({ error: e.message || String(e) });
  });

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
  return {
    mailboxes: mbs.map(repo.publicMailbox),
    folders: Object.fromEntries(mbs.map((m) => [m.id, repo.listFolders(m.id).map(folderPublic)])),
    counts: { ...repo.counts(user.id), focus: mbs.length ? priority.focus(user.id, settings, { dayStart }).stats : null },
  };
}


// ---------- 健康检查（探针用，无需登录） ----------
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1 AS ok').get();
    dbOk = true;
  } catch (e) {
    console.error('[health]', e.message);
  }
  let errorMailboxes = 0;
  try {
    errorMailboxes = repo.errorMailboxCount();
  } catch (_) {}
  const body = {
    ok: dbOk,
    db: dbOk ? 'up' : 'down',
    uptime: Math.round(process.uptime()),
    aiConfigured: ai.aiConfigured(),
    lastBackupAt: backup.lastBackupAt(),
    errorMailboxes,
  };
  res.status(dbOk ? 200 : 503).json(body);
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
    setCookie(res, users.createSession(u.id, req.headers['user-agent']), 30 * 24 * 3600);
    res.json({ user: users.publicUser(u) });
  })
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    rateLimit('login:' + req.ip, 10, 10 * 60_000);
    const u = users.authenticate(req.body.email, req.body.password);
    if (!u) throw httpError(401, '账号或密码错误');
    buckets.delete('login:' + req.ip);
    setCookie(res, users.createSession(u.id, req.headers['user-agent']), 30 * 24 * 3600);
    res.json({ user: users.publicUser(u) });
  })
);

app.post('/api/auth/logout', (req, res) => {
  users.destroySession(readCookie(req, COOKIE));
  setCookie(res, '', 0);
  res.json({ ok: true });
});

app.get(
  '/api/me',
  auth,
  wrap(async (req, res) => res.json({ user: users.publicUser(req.user), ai: ai.aiConfigured(), ...stateFor(req.user, req.query.dayStart) }))
);

app.get(
  '/api/state',
  auth,
  wrap(async (req, res) => res.json(stateFor(req.user, req.query.dayStart)))
);

// ---------- 今日待办 / 智能分拣 ----------
app.get(
  '/api/focus',
  auth,
  wrap(async (req, res) => {
    const mailboxId = req.query.mailboxId || 'all';
    if (mailboxId !== 'all') mailboxOf(req, mailboxId);
    res.json(priority.focus(req.user.id, users.publicUser(req.user).settings, { mailboxId, dayStart: req.query.dayStart }));
  })
);

app.get('/api/sender-rules', auth, (req, res) => res.json({ rules: priority.listRules(req.user.id) }));
app.post(
  '/api/sender-rules',
  auth,
  wrap(async (req, res) => {
    const key = priority.saveRule(req.user.id, req.body || {});
    emit(req.user.id, 'sync', { local: true });
    res.json({ ok: true, key });
  })
);
app.delete(
  '/api/sender-rules',
  auth,
  wrap(async (req, res) => {
    priority.deleteRule(req.user.id, req.query.key);
    emit(req.user.id, 'sync', { local: true });
    res.json({ ok: true });
  })
);

/** VIP 建议：往来频次 + 业务信号，不自动写入规则 */
app.get(
  '/api/vip-suggestions',
  auth,
  wrap(async (req, res) => {
    res.json({ suggestions: priority.vipSuggestions(req.user.id) });
  })
);

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
    if (b.signature !== undefined) patch.signature = String(b.signature).slice(0, 5000);

    let reconnect = false;
    if (b.password || b.advanced) {
      const conn = connectionFrom({ ...b, email: mb.email }, null, mb);
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
    else e.full();
    res.json({ ok: true });
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
      q: String(req.query.q || '').trim(),
      cursor: req.query.cursor,
      limit: Math.min(100, Math.max(10, Number(req.query.limit) || 50)),
    };
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
    res.json({ ...result, pinned });
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
async function loadBody(row) {
  const cached = repo.getBody(row.id);
  if (cached) return { html: cached.html, text: cached.text, meta: JSON.parse(cached.meta) };
  const mb = repo.getMailboxById(row.mailbox_id);
  const body = imap.serializeParsed(await imap.fetchParsed(mb, row.folder, row.uid));
  repo.saveBody(row.id, body);
  return body;
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
      body = await loadBody(row);
    } catch (e) {
      if (e.status === 404) {
        repo.deleteMessageRows([row.id]);
        throw httpError(404, '这封邮件已在其他客户端被移动或删除');
      }
      throw e;
    }
    if (req.query.markSeen !== '0') markSeen(row);
    res.json({
      ...repo.rowToMessage({ ...row, seen: 1 }),
      ...body.meta,
      html: body.html,
      text: body.text,
      knownSender: repo.isKnownContact(req.user.id, row.from_addr),
      sender: priority.senderInfo(req.user.id, row.from_addr),
    });
  })
);

app.get(
  '/api/messages/:id/thread',
  auth,
  wrap(async (req, res) => {
    const row = messageOf(req);
    res.json({ messages: repo.threadMessages(req.user.id, row).map(repo.rowToMessage) });
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
      } else repo.deleteMessageRows([r.id]);
    } catch {
      repo.deleteMessageRows([r.id]);
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

    switch (action) {
      case 'read':
      case 'unread': {
        const seen = action === 'read';
        repo.patchMessages(ids, { seen: seen ? 1 : 0 });
        await each(async (g) => {
          await imap.setFlags(g.mb, g.folder, g.rows.map((r) => r.uid), { seen });
          sync.touch(g.mb.id, g.folder);
        });
        break;
      }
      case 'flag':
      case 'unflag': {
        const flagged = action === 'flag';
        repo.patchMessages(ids, { flagged: flagged ? 1 : 0 });
        await each((g) => imap.setFlags(g.mb, g.folder, g.rows.map((r) => r.uid), { flagged }));
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
        break;
      case 'nofollow':
      case 'follow':
        repo.patchMessages(ids, { nudge_off: action === 'nofollow' ? 1 : 0 });
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
          if (action === 'trash') target = repo.specialFolder(g.mb.id, '\\Trash')?.path;
          if (action === 'spam') target = repo.specialFolder(g.mb.id, '\\Junk')?.path;
          if (action === 'notspam') target = repo.specialFolder(g.mb.id, '\\Inbox')?.path || 'INBOX';
          if (action === 'move') {
            if (!repo.getFolder(g.mb.id, dest)) throw httpError(400, '目标文件夹不存在（不能跨邮箱移动）');
            target = dest;
          }
          if (action === 'trash' && (!target || target === g.folder)) {
            await imap.expungeMessages(g.mb, g.folder, g.rows.map((r) => r.uid));
            repo.deleteMessageRows(g.rows.map((r) => r.id));
            all = false;
            return;
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
    emit(req.user.id, 'sync', { mailboxId: rows[0].mailbox_id, local: true });
    res.json({ ok: true, undoable });
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
      return res.json({ sent: true });
    }
    const dir = mailer.saveOutboxFiles(files);
    const id = repo.addOutbox(req.user.id, mb.id, payload, dir, sendAt);
    res.json({ outboxId: id, sendAt, scheduled: !!payload.sendAt });
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
    const o = repo.getOutbox(req.user.id, Number(req.params.id));
    if (!o) throw httpError(404, '邮件已发出，无法撤销');
    if (o.status === 'sending') throw httpError(409, '邮件正在发送，无法撤销');
    repo.deleteOutbox(o.id);
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
    sync.touch(mb.id, drafts.path);
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
      db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ? AND uid = ?').run(mb.id, drafts.path, uid);
      sync.touch(mb.id, drafts.path);
    }
    res.json({ ok: true });
  })
);

// ---------- 联系人 / 模板 ----------
app.get('/api/contacts', auth, (req, res) => res.json({ contacts: repo.searchContacts(req.user.id, String(req.query.q || '').trim()) }));

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

app.post('/api/ai/summarize', auth, wrap(async (req, res) => (aiLimit(req), res.json(await ai.summarize(await mailForAi(req, req.body.id))))));
app.post(
  '/api/ai/translate',
  auth,
  wrap(async (req, res) => {
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
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    res.json(await ai.draftReply(await mailForAi(req, req.body.id), { ...req.body, glossary: settings.glossary }));
  })
);
app.post(
  '/api/ai/compose',
  auth,
  wrap(async (req, res) => {
    aiLimit(req);
    const settings = users.settingsOf(req.user.id);
    res.json(await ai.compose({ ...req.body, glossary: settings.glossary }));
  })
);
app.post(
  '/api/ai/rewrite',
  auth,
  wrap(async (req, res) => {
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
    aiLimit(req);
    const { messages } = repo.queryMessages(req.user.id, { mailboxId: req.body.mailboxId || 'all', box: 'unread', limit: 40 });
    if (!messages.length) return res.json({ overview: '所有收件箱都没有未读邮件，一切都处理完了 🎉', priorities: [], groups: [] });
    const result = await ai.digest(messages.map((m) => ({ ...m, uid: m.id })));
    const byId = new Map(messages.map((m) => [m.id, m]));
    const pick = (id) => {
      const m = byId.get(Number(id));
      return m ? { id: m.id, subject: m.subject, from: m.from, mailboxId: m.mailboxId } : null;
    };
    res.json({
      overview: result.overview,
      priorities: (result.priorities || []).map((p) => ({ ...p, mail: pick(p.uid) })).filter((p) => p.mail),
      groups: (result.groups || []).map((g) => ({ ...g, mails: (g.uids || []).map(pick).filter(Boolean) })),
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
    aiLimit(req);
    const rows = repo.getMessagesForUser(req.user.id, (req.body.ids || []).slice(0, 25).map(Number));
    const todo = rows.filter((r) => !r.ai_note || req.body.force);
    if (todo.length) {
      const result = await ai.triage(todo.map((r) => ({ uid: r.id, from: { name: r.from_name, address: r.from_addr }, subject: r.subject, snippet: r.snippet })));
      const st = db.prepare('UPDATE messages SET ai_note = ? WHERE id = ?');
      for (const it of result.items || []) {
        const row = todo.find((r) => r.id === Number(it.uid));
        if (row && it.note) st.run(JSON.stringify({ note: String(it.note).slice(0, 120), urgency: it.urgency || 'medium', at: Date.now() }), row.id);
      }
    }
    const notes = repo.getMessagesForUser(req.user.id, rows.map((r) => r.id)).map((r) => [r.id, r.ai_note ? JSON.parse(r.ai_note) : null]);
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
mailer.startScheduler();
sync.startAll();
backup.startBackupScheduler();

/** 客户邮件超过回复时限仍未处理时分阶段提醒（冷却后升级，最多 3 级） */
function remindUser(u) {
  const settings = users.publicUser(u).settings;
  if (!settings.remindOverdue || !isOnline(u.id) || !repo.listMailboxes(u.id).length) return;
  try {
    const r = priority.overdueToRemind(u.id, settings);
    if (r) emit(u.id, 'remind', r);
  } catch (e) {
    console.error('[remind]', e.message);
  }
}
const remindOverdue = () => db.prepare('SELECT * FROM users').all().forEach(remindUser);
setTimeout(remindOverdue, 60_000).unref();
setInterval(remindOverdue, 10 * 60_000).unref();
const server = app.listen(PORT, () => console.log(`[zito-mail] 服务已启动 http://localhost:${PORT}`));

function shutdown(signal) {
  console.log(`[zito-mail] 收到 ${signal}，正在关闭…`);
  server.close(() => {
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
