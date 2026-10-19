import { db, now } from './db.js';
import { assertScopeReadable, resolveScopes } from './deals.js';

function publicNote(r, usersById) {
  const u = usersById?.get(r.user_id);
  return {
    id: r.id,
    userId: r.user_id,
    threadId: r.thread_id || '',
    address: r.address || '',
    body: r.body,
    createdAt: r.created_at,
    author: u
      ? { id: u.id, name: u.name || u.email, email: u.email }
      : { id: r.user_id, name: '同事', email: '' },
  };
}

function loadUsers(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  for (const u of db.prepare(`SELECT id, name, email FROM users WHERE id IN (${ph})`).all(...ids)) {
    map.set(u.id, u);
  }
  return map;
}

function assertNotesReadable(userId, { threadId, address } = {}) {
  const addr = String(address || '').trim();
  if (addr) {
    const scopes = resolveScopes(addr);
    if (!scopes) throw Object.assign(new Error('无效地址'), { status: 400 });
    assertScopeReadable(userId, scopes.default.key);
    return;
  }
  const tid = String(threadId || '').trim();
  if (!tid) throw Object.assign(new Error('缺少会话或地址'), { status: 400 });
  const hit = db
    .prepare(
      `SELECT 1 AS ok FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND m.thread_id = ? LIMIT 1`
    )
    .get(userId, tid);
  if (!hit) {
    const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (admin?.role !== 'admin') {
      throw Object.assign(new Error('无权查看该会话备注'), { status: 403 });
    }
  }
}

/** 有往来 / 认领范围内可读内部备注（单团队部署） */
export function listNotes(userId, { threadId, address, limit = 30 } = {}) {
  try {
    assertNotesReadable(userId, { threadId, address });
  } catch (e) {
    if (e.status === 403 || e.status === 400) return [];
    throw e;
  }
  const lim = Math.min(80, Math.max(1, Number(limit) || 30));
  let rows = [];
  if (threadId) {
    rows = db
      .prepare(`SELECT * FROM thread_notes WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(String(threadId), lim);
  }
  if ((!rows.length || !threadId) && address) {
    const more = db
      .prepare(`SELECT * FROM thread_notes WHERE lower(address) = lower(?) ORDER BY created_at DESC LIMIT ?`)
      .all(String(address), lim);
    const seen = new Set(rows.map((r) => r.id));
    for (const r of more) if (!seen.has(r.id)) rows.push(r);
  }
  rows.sort((a, b) => b.created_at - a.created_at);
  const users = loadUsers([...new Set(rows.map((r) => r.user_id))]);
  return rows.slice(0, lim).map((r) => publicNote(r, users));
}

export function addNote(userId, { threadId, address, body } = {}) {
  const text = String(body || '').trim().slice(0, 2000);
  if (!text) throw Object.assign(new Error('请填写内部备注'), { status: 400 });
  const tid = String(threadId || '').trim().slice(0, 500);
  const addr = String(address || '').trim().toLowerCase().slice(0, 200);
  if (!tid && !addr) throw Object.assign(new Error('缺少会话或地址'), { status: 400 });
  assertNotesReadable(userId, { threadId: tid, address: addr });
  const id = Number(
    db
      .prepare(
        `INSERT INTO thread_notes (user_id, thread_id, address, body, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, tid, addr, text, now()).lastInsertRowid
  );
  const row = db.prepare('SELECT * FROM thread_notes WHERE id = ?').get(id);
  return publicNote(row, loadUsers([userId]));
}

export function deleteNote(userId, id, { admin = false } = {}) {
  const row = db.prepare('SELECT * FROM thread_notes WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('备注不存在'), { status: 404 });
  if (row.user_id !== userId && !admin) {
    throw Object.assign(new Error('只能删除自己的备注'), { status: 403 });
  }
  db.prepare('DELETE FROM thread_notes WHERE id = ?').run(id);
  return { ok: true };
}
