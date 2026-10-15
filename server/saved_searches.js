import { db, now, tx } from './db.js';

const MAX_SAVED = 50;
const MAX_NAME = 40;
const MAX_QUERY = 500;

/** 外贸推荐智能文件夹模板（创建时可选，不强制预置） */
export const TRADE_SEARCH_PRESETS = [
  { name: '有附件', query: 'has:attachment', icon: 'paperclip' },
  { name: 'VIP 未读', query: 'is:vip is:unread', icon: 'star' },
  { name: '未读询盘', query: 'is:unread subject:询价', icon: 'search' },
  { name: '待开票标签', query: 'label:待开票', icon: 'tag' },
];

const ALLOWED_ICONS = new Set(['bookmark', 'star', 'search', 'paperclip', 'tag', 'mail', 'flag', 'folder']);

function sanitizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

function sanitizeQuery(query) {
  return String(query || '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY);
}

function sanitizeIcon(icon) {
  const s = String(icon || '').trim().toLowerCase();
  if (!s) return null;
  return ALLOWED_ICONS.has(s) ? s : 'bookmark';
}

function rowPublic(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    query: r.query,
    icon: r.icon || null,
    pinned: !!r.pinned,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listSavedSearches(userId) {
  return db
    .prepare(
      `SELECT id, name, query, icon, pinned, position, created_at, updated_at
       FROM saved_searches WHERE user_id = ?
       ORDER BY pinned DESC, position ASC, id ASC`
    )
    .all(userId)
    .map(rowPublic);
}

export function getSavedSearch(userId, id) {
  const r = db
    .prepare(
      `SELECT id, name, query, icon, pinned, position, created_at, updated_at
       FROM saved_searches WHERE user_id = ? AND id = ?`
    )
    .get(userId, id);
  return rowPublic(r);
}

export function createSavedSearch(userId, { name, query, icon, pinned, position } = {}) {
  const n = sanitizeName(name);
  const q = sanitizeQuery(query);
  if (!n) throw Object.assign(new Error('请输入名称'), { status: 400 });
  if (!q) throw Object.assign(new Error('查询不能为空'), { status: 400 });
  const total = db.prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?').get(userId).n;
  if (total >= MAX_SAVED) throw Object.assign(new Error(`最多保存 ${MAX_SAVED} 个智能文件夹`), { status: 400 });
  const clash = db
    .prepare('SELECT id FROM saved_searches WHERE user_id = ? AND name = ? COLLATE NOCASE')
    .get(userId, n);
  if (clash) throw Object.assign(new Error('已有同名智能文件夹'), { status: 409 });
  const pos =
    position != null
      ? Number(position)
      : (db.prepare('SELECT IFNULL(MAX(position), -1) + 1 AS p FROM saved_searches WHERE user_id = ?').get(userId).p || 0);
  const t = now();
  const pin = pinned === false || pinned === 0 ? 0 : 1;
  const info = db
    .prepare(
      `INSERT INTO saved_searches (user_id, name, query, icon, pinned, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, n, q, sanitizeIcon(icon), pin, pos, t, t);
  return getSavedSearch(userId, Number(info.lastInsertRowid));
}

export function updateSavedSearch(userId, id, patch = {}) {
  const row = getSavedSearch(userId, id);
  if (!row) throw Object.assign(new Error('智能文件夹不存在'), { status: 404 });
  let name = row.name;
  let query = row.query;
  let icon = row.icon;
  let pinned = row.pinned ? 1 : 0;
  let position = row.position;
  if (patch.name != null) {
    name = sanitizeName(patch.name);
    if (!name) throw Object.assign(new Error('请输入名称'), { status: 400 });
    const clash = db
      .prepare('SELECT id FROM saved_searches WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(userId, name, id);
    if (clash) throw Object.assign(new Error('已有同名智能文件夹'), { status: 409 });
  }
  if (patch.query != null) {
    query = sanitizeQuery(patch.query);
    if (!query) throw Object.assign(new Error('查询不能为空'), { status: 400 });
  }
  if (patch.icon !== undefined) icon = sanitizeIcon(patch.icon);
  if (patch.pinned != null) pinned = patch.pinned === false || patch.pinned === 0 ? 0 : 1;
  if (patch.position != null) position = Number(patch.position) || 0;
  db.prepare(
    `UPDATE saved_searches SET name = ?, query = ?, icon = ?, pinned = ?, position = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(name, query, icon, pinned, position, now(), id, userId);
  return getSavedSearch(userId, id);
}

export function deleteSavedSearch(userId, id) {
  const row = getSavedSearch(userId, id);
  if (!row) throw Object.assign(new Error('智能文件夹不存在'), { status: 404 });
  db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, userId);
  return { ok: true };
}

export function reorderSavedSearches(userId, ids = []) {
  const list = listSavedSearches(userId);
  const have = new Set(list.map((s) => s.id));
  const ordered = ids.map(Number).filter((id) => have.has(id));
  for (const s of list) if (!ordered.includes(s.id)) ordered.push(s.id);
  const st = db.prepare('UPDATE saved_searches SET position = ?, updated_at = ? WHERE id = ? AND user_id = ?');
  const t = now();
  tx(() => ordered.forEach((id, i) => st.run(i, t, id, userId)))();
  return listSavedSearches(userId);
}

/** 一键创建推荐模板（已存在同名则跳过） */
export function applyTradePresets(userId) {
  const created = [];
  const skipped = [];
  for (const p of TRADE_SEARCH_PRESETS) {
    const exists = db
      .prepare('SELECT id, name FROM saved_searches WHERE user_id = ? AND name = ? COLLATE NOCASE')
      .get(userId, p.name);
    if (exists) {
      skipped.push(exists.name);
      continue;
    }
    try {
      created.push(createSavedSearch(userId, p));
    } catch (e) {
      if (e.status === 400 && /最多/.test(e.message)) break;
      skipped.push(p.name);
    }
  }
  return { created, skipped, savedSearches: listSavedSearches(userId) };
}
