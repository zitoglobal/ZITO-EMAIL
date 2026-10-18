import { db, now } from './db.js';

const SEED = [
  { code: 'zieshine', name: 'ZIESHINE', color: '#0a66ff' },
  { code: 'elevia', name: 'ELEVIA', color: '#7c3aed' },
  { code: 'manlor', name: 'MANLOR', color: '#0d9488' },
];

function publicBrand(r) {
  return {
    id: r.id,
    userId: r.user_id,
    code: r.code,
    name: r.name,
    color: r.color,
    team: !!r.team,
    createdAt: r.created_at,
  };
}

function firstUserId(fallback) {
  return db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get()?.id || fallback || 0;
}

/** 合并同 code 的个人种子到团队品牌，并重映射 mailbox/template/deal 外键 */
function promoteAndDedupe(code, name, color) {
  const t = now();
  let canonical = db.prepare('SELECT * FROM brands WHERE code = ? AND team = 1 ORDER BY id ASC LIMIT 1').get(code);
  if (!canonical) {
    const oldest = db.prepare('SELECT * FROM brands WHERE code = ? ORDER BY id ASC LIMIT 1').get(code);
    if (oldest) {
      db.prepare('UPDATE brands SET team = 1, name = COALESCE(NULLIF(name,\'\'), ?), color = COALESCE(NULLIF(color,\'\'), ?) WHERE id = ?').run(
        name,
        color,
        oldest.id
      );
      canonical = db.prepare('SELECT * FROM brands WHERE id = ?').get(oldest.id);
    } else {
      const uid = firstUserId(1);
      if (!uid) return null;
      const id = Number(
        db
          .prepare(
            `INSERT INTO brands (user_id, code, name, color, created_at, team) VALUES (?, ?, ?, ?, ?, 1)`
          )
          .run(uid, code, name, color, t).lastInsertRowid
      );
      canonical = db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
    }
  }
  const dups = db.prepare('SELECT id FROM brands WHERE code = ? AND id != ?').all(code, canonical.id);
  for (const d of dups) {
    db.prepare('UPDATE mailboxes SET brand_id = ? WHERE brand_id = ?').run(canonical.id, d.id);
    try {
      db.prepare('UPDATE templates SET brand_id = ? WHERE brand_id = ?').run(canonical.id, d.id);
    } catch {
      /* templates.brand_id may not exist on old DBs mid-migrate */
    }
    try {
      db.prepare('UPDATE deals SET brand_id = ? WHERE brand_id = ?').run(canonical.id, d.id);
    } catch {
      /* ignore */
    }
    db.prepare('DELETE FROM brands WHERE id = ?').run(d.id);
  }
  return canonical;
}

/** 启动/首次列表时：确保三品牌为团队主数据，去重 per-user 复制 */
export function ensureTeamBrands() {
  const cols = new Set(db.prepare('PRAGMA table_info(brands)').all().map((c) => c.name));
  if (!cols.has('team')) return listTeamAndUser(0);
  for (const b of SEED) promoteAndDedupe(b.code, b.name, b.color);
  return true;
}

export function ensureBrands(userId) {
  ensureTeamBrands();
  return listBrands(userId);
}

function listTeamAndUser(userId) {
  const uid = Number(userId) || 0;
  return db
    .prepare(
      `SELECT * FROM brands
       WHERE team = 1 OR user_id = ?
       ORDER BY team DESC, id ASC`
    )
    .all(uid)
    .map(publicBrand);
}

export function listBrands(userId) {
  ensureTeamBrands();
  return listTeamAndUser(userId);
}

export function getBrand(userId, brandId) {
  if (!brandId) return null;
  const r = db
    .prepare('SELECT * FROM brands WHERE id = ? AND (team = 1 OR user_id = ?)')
    .get(Number(brandId), userId);
  return r ? publicBrand(r) : null;
}

export function createBrand(userId, { code, name, color } = {}) {
  ensureTeamBrands();
  const c = String(code || name || 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40) || 'custom';
  const n = String(name || c).trim().slice(0, 80);
  if (!n) throw Object.assign(new Error('请填写品牌名称'), { status: 400 });
  if (SEED.some((s) => s.code === c)) {
    throw Object.assign(new Error('该品牌代码为团队保留，请换一个'), { status: 400 });
  }
  try {
    const id = Number(
      db
        .prepare(
          `INSERT INTO brands (user_id, code, name, color, created_at, team) VALUES (?, ?, ?, ?, ?, 0)`
        )
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
