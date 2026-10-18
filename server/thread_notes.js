import { db, now } from './db.js';

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

/** 团队内可见：任意登录用户可读本实例备注（不做跨租户隔离；单团队部署） */
export function listNotes({ threadId, address, limit = 30 } = {}) {
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
