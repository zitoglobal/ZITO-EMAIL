import { db, now } from './db.js';

const SEED = [
  { code: 'zieshine', name: 'ZIESHINE', color: '#0a66ff' },
  { code: 'elevia', name: 'ELEVIA', color: '#7c3aed' },
  { code: 'manlor', name: 'MANLOR', color: '#0d9488' },
];

export function ensureBrands(userId) {
  const uid = Number(userId);
  if (!uid) return [];
  const t = now();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO brands (user_id, code, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  for (const b of SEED) ins.run(uid, b.code, b.name, b.color, t);
  return listBrands(uid);
}

export function listBrands(userId) {
  ensureSeedOnly(userId);
  return db
    .prepare('SELECT id, user_id AS userId, code, name, color, created_at AS createdAt FROM brands WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map(publicBrand);
}

function ensureSeedOnly(userId) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM brands WHERE user_id = ?').get(userId)?.n || 0;
  if (n === 0) {
    const t = now();
    const ins = db.prepare(
      `INSERT INTO brands (user_id, code, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const b of SEED) ins.run(userId, b.code, b.name, b.color, t);
  }
}

function publicBrand(r) {
  return {
    id: r.id,
    userId: r.userId ?? r.user_id,
    code: r.code,
    name: r.name,
    color: r.color,
    createdAt: r.createdAt ?? r.created_at,
  };
}

export function getBrand(userId, brandId) {
  if (!brandId) return null;
  const r = db.prepare('SELECT * FROM brands WHERE id = ? AND user_id = ?').get(brandId, userId);
  return r ? publicBrand(r) : null;
}

export function createBrand(userId, { code, name, color } = {}) {
  const c = String(code || name || 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40) || 'custom';
  const n = String(name || c).trim().slice(0, 80);
  if (!n) throw Object.assign(new Error('请填写品牌名称'), { status: 400 });
  try {
    const id = Number(
      db
        .prepare('INSERT INTO brands (user_id, code, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, c, n, String(color || '#0a66ff').slice(0, 20), now()).lastInsertRowid
    );
    return getBrand(userId, id);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw Object.assign(new Error('品牌代码已存在'), { status: 409 });
    }
    throw e;
  }
}

export function setMailboxBrand(userId, mailboxId, brandId) {
  const mb = db.prepare('SELECT id FROM mailboxes WHERE id = ? AND user_id = ?').get(mailboxId, userId);
  if (!mb) throw Object.assign(new Error('邮箱不存在'), { status: 404 });
  let bid = null;
  if (brandId != null && brandId !== '') {
    const b = getBrand(userId, Number(brandId));
    if (!b) throw Object.assign(new Error('品牌不存在'), { status: 400 });
    bid = b.id;
  }
  db.prepare('UPDATE mailboxes SET brand_id = ? WHERE id = ?').run(bid, mailboxId);
  return { mailboxId, brandId: bid };
}
