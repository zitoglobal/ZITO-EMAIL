import { db, now, tx } from './db.js';

/** 有限色板（token 名或 #RRGGBB） */
export const LABEL_COLORS = [
  '#0a66ff', // 蓝
  '#7c3aed', // 紫
  '#db2777', // 粉
  '#dc2626', // 红
  '#ea580c', // 橙
  '#ca8a04', // 金
  '#16a34a', // 绿
  '#0d9488', // 青
  '#475569', // 灰
  '#0891b2', // 天蓝
];

/** 外贸服饰推荐邮件标签（一键创建，不强制预置） */
export const TRADE_LABEL_PRESETS = [
  { name: '询盘', color: '#0a66ff' },
  { name: '报价中', color: '#7c3aed' },
  { name: '样品', color: '#0d9488' },
  { name: '大货', color: '#16a34a' },
  { name: '付款', color: '#ca8a04' },
  { name: '成交', color: '#11653b' },
  { name: '丢单', color: '#9f2a2a' },
  { name: '投诉', color: '#dc2626' },
  { name: '待开票', color: '#ea580c' },
  { name: '物流', color: '#0891b2' },
];

/** 业务阶段 → 外贸标签名 */
export const STAGE_TO_LABEL = {
  inquiry: '询盘',
  quote: '报价中',
  sample: '样品',
  bulk: '大货',
  payment: '付款',
  won: '成交',
  lost: '丢单',
};

const STAGE_LABEL_NAMES = new Set(Object.values(STAGE_TO_LABEL));

/** 确保阶段对应标签存在，返回 label 行 */
export function ensureStageLabel(userId, stageId) {
  const name = STAGE_TO_LABEL[stageId];
  if (!name) return null;
  const existing = db.prepare('SELECT id, name, color, position, created_at AS createdAt FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name);
  if (existing) return existing;
  const preset = TRADE_LABEL_PRESETS.find((p) => p.name === name) || { name, color: '#0a66ff' };
  try {
    return createLabel(userId, preset);
  } catch (e) {
    if (e.status === 409) {
      return db.prepare('SELECT id, name, color, position, created_at AS createdAt FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name);
    }
    throw e;
  }
}

/** 给邮件贴上阶段标签，并去掉其他阶段标签（避免互斥冲突） */
export function applyStageLabel(userId, messageId, stageId) {
  const label = ensureStageLabel(userId, stageId);
  if (!label || !messageId) return { label: null, updated: 0 };
  const stageIds = db
    .prepare(
      `SELECT id FROM labels WHERE user_id = ? AND name IN (${[...STAGE_LABEL_NAMES].map(() => '?').join(',')})`
    )
    .all(userId, ...STAGE_LABEL_NAMES)
    .map((r) => r.id);
  const remove = stageIds.filter((id) => id !== label.id);
  return {
    label,
    ...setMessageLabels(userId, [messageId], { add: [label.id], remove }),
  };
}

const MAX_LABELS = 100;
const MAX_PER_MESSAGE = 20;

function sanitizeColor(c) {
  const s = String(c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (LABEL_COLORS.includes(s)) return s;
  return LABEL_COLORS[0];
}

function sanitizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

export function listLabels(userId) {
  return db
    .prepare(
      `SELECT l.id, l.name, l.color, l.position, l.created_at AS createdAt,
        (SELECT COUNT(*) FROM message_labels ml WHERE ml.label_id = l.id) AS count
       FROM labels l WHERE l.user_id = ? ORDER BY l.position ASC, l.id ASC`
    )
    .all(userId);
}

export function getLabel(userId, id) {
  return db.prepare('SELECT id, name, color, position, created_at AS createdAt FROM labels WHERE user_id = ? AND id = ?').get(userId, id);
}

export function createLabel(userId, { name, color, position } = {}) {
  const n = sanitizeName(name);
  if (!n) throw Object.assign(new Error('请输入标签名称'), { status: 400 });
  const total = db.prepare('SELECT COUNT(*) AS n FROM labels WHERE user_id = ?').get(userId).n;
  if (total >= MAX_LABELS) throw Object.assign(new Error(`最多创建 ${MAX_LABELS} 个标签`), { status: 400 });
  const exists = db.prepare('SELECT id FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, n);
  if (exists) throw Object.assign(new Error('已有同名标签'), { status: 409 });
  const pos =
    position != null
      ? Number(position)
      : (db.prepare('SELECT IFNULL(MAX(position), -1) + 1 AS p FROM labels WHERE user_id = ?').get(userId).p || 0);
  const info = db
    .prepare('INSERT INTO labels (user_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, n, sanitizeColor(color), pos, now());
  return getLabel(userId, Number(info.lastInsertRowid));
}

export function updateLabel(userId, id, patch = {}) {
  const row = getLabel(userId, id);
  if (!row) throw Object.assign(new Error('标签不存在'), { status: 404 });
  let name = row.name;
  let color = row.color;
  let position = row.position;
  if (patch.name != null) {
    name = sanitizeName(patch.name);
    if (!name) throw Object.assign(new Error('请输入标签名称'), { status: 400 });
    const clash = db
      .prepare('SELECT id FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(userId, name, id);
    if (clash) throw Object.assign(new Error('已有同名标签'), { status: 409 });
  }
  if (patch.color != null) color = sanitizeColor(patch.color);
  if (patch.position != null) position = Number(patch.position) || 0;
  db.prepare('UPDATE labels SET name = ?, color = ?, position = ? WHERE id = ? AND user_id = ?').run(name, color, position, id, userId);
  return getLabel(userId, id);
}

export function deleteLabel(userId, id) {
  const row = getLabel(userId, id);
  if (!row) throw Object.assign(new Error('标签不存在'), { status: 404 });
  // message_labels 级联删除；不删邮件
  db.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?').run(id, userId);
  return { ok: true };
}

/** 一键创建外贸推荐标签（已存在同名则跳过） */
export function applyTradePresets(userId) {
  const created = [];
  const skipped = [];
  for (const p of TRADE_LABEL_PRESETS) {
    const exists = db.prepare('SELECT id, name FROM labels WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, p.name);
    if (exists) {
      skipped.push(exists.name);
      continue;
    }
    try {
      created.push(createLabel(userId, p));
    } catch (e) {
      if (e.status === 400 && /最多/.test(e.message)) break;
      skipped.push(p.name);
    }
  }
  return { created, skipped, labels: listLabels(userId) };
}

export function reorderLabels(userId, ids = []) {
  const list = listLabels(userId);
  const have = new Set(list.map((l) => l.id));
  const ordered = ids.map(Number).filter((id) => have.has(id));
  for (const l of list) if (!ordered.includes(l.id)) ordered.push(l.id);
  const st = db.prepare('UPDATE labels SET position = ? WHERE id = ? AND user_id = ?');
  tx(() => ordered.forEach((id, i) => st.run(i, id, userId)))();
  return listLabels(userId);
}

/** 批量贴/撕标签；add/remove 为 label id 数组 */
export function setMessageLabels(userId, messageIds, { add = [], remove = [] } = {}) {
  const ids = [...new Set((messageIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { ok: true, updated: 0 };

  const owned = db
    .prepare(
      `SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND m.id IN (${ids.map(() => '?').join(',')})`
    )
    .all(userId, ...ids)
    .map((r) => r.id);
  if (!owned.length) return { ok: true, updated: 0 };

  const addIds = [...new Set(add.map(Number).filter(Number.isInteger))];
  const removeIds = [...new Set(remove.map(Number).filter(Number.isInteger))];
  const validAdd = addIds.filter((lid) => getLabel(userId, lid));
  const validRemove = removeIds.filter((lid) => getLabel(userId, lid));

  const countSt = db.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE message_pk = ?');
  const hasSt = db.prepare('SELECT 1 FROM message_labels WHERE message_pk = ? AND label_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO message_labels (message_pk, label_id, created_at) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM message_labels WHERE message_pk = ? AND label_id = ?');
  const t = now();

  tx(() => {
    for (const mid of owned) {
      for (const lid of validRemove) del.run(mid, lid);
      let n = countSt.get(mid).n;
      for (const lid of validAdd) {
        if (n >= MAX_PER_MESSAGE) break;
        if (hasSt.get(mid, lid)) continue;
        ins.run(mid, lid, t);
        n += 1;
      }
    }
  })();

  return { ok: true, updated: owned.length, labelsByMessage: labelsByMessageIds(userId, owned) };
}

export function labelsByMessageIds(userId, messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return {};
  const rows = db
    .prepare(
      `SELECT ml.message_pk AS messagePk, l.id, l.name, l.color
       FROM message_labels ml
       JOIN labels l ON l.id = ml.label_id
       WHERE l.user_id = ? AND ml.message_pk IN (${ids.map(() => '?').join(',')})
       ORDER BY l.position ASC, l.id ASC`
    )
    .all(userId, ...ids);
  const out = {};
  for (const r of rows) {
    if (!out[r.messagePk]) out[r.messagePk] = [];
    out[r.messagePk].push({ id: r.id, name: r.name, color: r.color });
  }
  return out;
}

/** 给消息对象数组挂上 labels 字段 */
export function attachLabels(userId, messages) {
  if (!messages?.length) return messages || [];
  const map = labelsByMessageIds(
    userId,
    messages.map((m) => m.id)
  );
  return messages.map((m) => ({ ...m, labels: map[m.id] || [] }));
}
