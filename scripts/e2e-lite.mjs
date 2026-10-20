/**
 * 不连真实 IMAP/SMTP 的 HTTP 冒烟：临时库 + demo 邮箱。
 * 覆盖：登录、/state 未读角标、/focus listMeta、读正文（不打 IMAP）、批量已读后角标、管理员 FTS 状态。
 * 运行：npm run test:e2e-lite
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zito-e2e-'));
const port = Number(process.env.E2E_PORT || 18770 + Math.floor(Math.random() * 200));
const base = `http://127.0.0.1:${port}/api`;

let fail = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`OK  ${name}`);
  else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    MAIL_SECRET: 'e2e-lite-secret-not-for-prod-use',
    ADMIN_TOTP_REQUIRED: '0',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logTail = '';
const take = (buf) => {
  logTail = (logTail + buf.toString()).slice(-4000);
};
child.stdout.on('data', take);
child.stderr.on('data', take);

function shutdown() {
  if (child.exitCode != null || child.killed) return;
  child.kill();
}

async function waitHealth(ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode != null) throw new Error('server exited early\n' + logTail);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('health timeout\n' + logTail);
}

let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const headers = { 'x-zm': '1', cookie };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  if (!r.ok) {
    const err = new Error(`${method} ${p} ${r.status} ${data?.error || text.slice(0, 120)}`);
    err.data = data;
    throw err;
  }
  return data;
}

function seed(userId) {
  const db = new Database(path.join(dataDir, 'mail.db'));
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const MB = 'e2e-demo';
  const email = 'alice@zito.test';
  const now = Date.now();
  const H = 3600_000;
  db.prepare(
    `INSERT INTO mailboxes (id, user_id, email, name, color, provider, provider_name, login_user, pass_enc,
       imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, status, last_sync, created_at)
     VALUES (?, ?, ?, 'Alice', '#0a66ff', 'demo', '演示', ?, 'demo', 'demo', 993, 1, 'demo', 465, 1, 'ok', ?, ?)`
  ).run(MB, userId, email, email, now, now);
  db.prepare(
    `INSERT INTO folders (mailbox_id, path, name, special_use, total, unseen, last_sync) VALUES (?, 'INBOX', '收件箱', '\\Inbox', 2, 2, ?)`
  ).run(MB, now);
  db.prepare(
    `INSERT INTO folders (mailbox_id, path, name, special_use, total, unseen, last_sync) VALUES (?, 'Sent', '已发送', '\\Sent', 1, 0, ?)`
  ).run(MB, now);
  const ins = db.prepare(
    `INSERT INTO messages (mailbox_id, folder, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
       date, sort_ts, seen, flagged, answered, has_att, snippet, category, signals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, 0, 0, ?, 'people', ?)`
  );
  const body = db.prepare(
    `INSERT INTO bodies (message_pk, html, text, meta, fetched_at) VALUES (?, ?, ?, ?, ?)`
  );
  const meta = JSON.stringify({ mediaVer: 3 });
  const rows = [
    {
      folder: 'INBOX', uid: 1, seen: 0, hours: 2,
      from: ['Mike', 'mike@fashionhub-usa.com'],
      to: [{ name: 'Alice', address: email }],
      subject: 'Please quote FOB for yoga leggings MOQ 3000',
      text: 'Could you send a quotation for 3000 pcs yoga leggings?',
    },
    {
      folder: 'INBOX', uid: 2, seen: 0, hours: 5,
      from: ['Sarah', 'sarah@newbrand.co.uk'],
      to: [{ name: 'Alice', address: email }],
      subject: 'Sample request lab dips',
      text: 'Could you send lab dips for navy?',
    },
    {
      folder: 'Sent', uid: 3, seen: 1, hours: 20,
      from: ['Alice', email],
      to: [{ name: 'Carlos', address: 'carlos@lisboa.pt' }],
      subject: 'Quotation for polo shirts — please confirm',
      text: 'Please confirm the order quantity.',
    },
  ];
  const ids = [];
  for (const t of rows) {
    const date = now - t.hours * H;
    const id = ins.run(
      MB, t.folder, t.uid, `<e2e-${t.uid}@zito.test>`, `thread-${t.uid}`, t.subject,
      t.from[0], t.from[1], JSON.stringify(t.to), date, date, t.seen, t.text,
      JSON.stringify(['inquiry'])
    ).lastInsertRowid;
    body.run(id, `<p>${t.text}</p>`, t.text, meta, now);
    ids.push(Number(id));
  }
  db.close();
  return { inboxIds: ids.slice(0, 2), sentId: ids[2] };
}

try {
  await waitHealth();
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: 'admin@zito.test', name: '管理员', password: 'Passw0rd!' },
  });
  assert('register admin', reg.user?.role === 'admin');
  const seeded = seed(reg.user.id);

  const state = await call('/state');
  assert('state fts shape', typeof state.fts?.busy === 'boolean' && typeof state.fts?.backfillLeft === 'number');
  assert('unified unread before', state.counts?.unifiedUnread === 2, `got ${state.counts?.unifiedUnread}`);

  const focus = await call('/focus');
  assert('focus listMeta', (focus.listMeta?.replyTotal || 0) >= 1, JSON.stringify(focus.listMeta));
  assert('focus follow visible', (focus.listMeta?.followTotal || 0) >= 1, JSON.stringify(focus.listMeta));

  const detail = await call(`/messages/${seeded.inboxIds[0]}?markSeen=0`);
  assert('body without imap', String(detail.html || '').includes('quotation') || String(detail.text || '').includes('quotation'));

  await call('/messages/actions', { method: 'POST', body: { ids: seeded.inboxIds, action: 'read' } });
  const after = await call('/state');
  assert('unified unread after batch read', after.counts?.unifiedUnread === 0, `got ${after.counts?.unifiedUnread}`);

  const fts = await call('/admin/fts');
  assert('admin fts', typeof fts.busy === 'boolean' && typeof fts.backfillLeft === 'number');
} catch (e) {
  fail += 1;
  console.log('FAIL runner —', e.message);
  if (logTail) console.log(logTail);
} finally {
  shutdown();
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

if (fail) {
  console.log(`e2e-lite ${fail} failed`);
  process.exit(1);
}
console.log('e2e-lite passed');
