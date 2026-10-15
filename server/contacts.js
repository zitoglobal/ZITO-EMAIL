import { db, now, tx } from './db.js';

/** 与邮件标签色板一致，客户标签独立表 */
export const CONTACT_TAG_COLORS = [
  '#0a66ff',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0d9488',
  '#475569',
  '#0891b2',
];

export const TRADE_CONTACT_TAG_PRESETS = [
  { name: 'EU买家', color: '#0a66ff' },
  { name: 'US买家', color: '#7c3aed' },
  { name: 'ODM', color: '#0d9488' },
  { name: 'OEM', color: '#16a34a' },
  { name: '品牌客户', color: '#ca8a04' },
  { name: '代理商', color: '#ea580c' },
];

const MAX_PERSONS = 5000;
const MAX_NOTE = 2000;
const MAX_NAME = 80;
const MAX_COMPANY = 120;
const MAX_TAGS = 100;
const MAX_TAGS_PER_PERSON = 20;
const MAX_ADDRESSES = 20;

const SKIP_ADDR = /no[-_.]?reply|mailer-daemon|postmaster@/i;

function sanitizeColor(c) {
  const s = String(c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (CONTACT_TAG_COLORS.includes(s)) return s;
  return CONTACT_TAG_COLORS[0];
}

function sanitizeName(name, max = MAX_NAME) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function sanitizeNote(note) {
  return String(note || '').slice(0, MAX_NOTE);
}

function normAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function validAddress(address) {
  const a = normAddress(address);
  return a && /@/.test(a) && !SKIP_ADDR.test(a);
}

function like(s) {
  return `%${String(s).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
}

function personTags(personId) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color FROM contact_tags t
       JOIN contact_tag_map m ON m.tag_id = t.id
       WHERE m.person_id = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(personId);
}

function personAddresses(personId) {
  return db
    .prepare(
      `SELECT address, is_primary AS isPrimary, source, name, score, last_at AS lastAt
       FROM contact_addresses WHERE person_id = ?
       ORDER BY is_primary DESC, score DESC, last_at DESC`
    )
    .all(personId)
    .map((r) => ({
      address: r.address,
      isPrimary: !!r.isPrimary,
      source: r.source,
      name: r.name || '',
      score: r.score || 0,
      lastAt: r.lastAt || null,
    }));
}

function senderRuleFor(userId, address) {
  const addr = normAddress(address);
  if (!addr) return null;
  const exact = db.prepare('SELECT key, kind, name FROM sender_rules WHERE user_id = ? AND key = ?').get(userId, addr);
  if (exact) return exact;
  const domain = addr.includes('@') ? '@' + addr.split('@')[1] : '';
  if (!domain) return null;
  return db.prepare('SELECT key, kind, name FROM sender_rules WHERE user_id = ? AND key = ?').get(userId, domain) || null;
}

function publicPerson(row, userId) {
  if (!row) return null;
  const addresses = personAddresses(row.id);
  const tags = personTags(row.id);
  const primary = addresses.find((a) => a.isPrimary)?.address || row.primary_address;
  const rule = senderRuleFor(userId, primary);
  const score = addresses.reduce((s, a) => s + (a.score || 0), 0);
  const lastAt = addresses.reduce((m, a) => Math.max(m, a.lastAt || 0), 0) || null;
  return {
    id: row.id,
    displayName: row.display_name || '',
    company: row.company || '',
    note: row.note || '',
    primaryAddress: primary,
    addresses,
    tags,
    rule: rule ? { key: rule.key, kind: rule.kind, name: rule.name || '' } : null,
    score,
    lastAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(userId, id) {
  return db.prepare('SELECT * FROM contact_persons WHERE user_id = ? AND id = ?').get(userId, id);
}

export function getPerson(userId, id) {
  return publicPerson(getRow(userId, id), userId);
}

export function listPersons(userId, { q = '', limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  let rows;
  if (q && String(q).trim()) {
    const pat = like(String(q).trim());
    rows = db
      .prepare(
        `SELECT DISTINCT p.* FROM contact_persons p
         LEFT JOIN contact_addresses a ON a.person_id = p.id
         LEFT JOIN contact_tag_map tm ON tm.person_id = p.id
         LEFT JOIN contact_tags t ON t.id = tm.tag_id
         WHERE p.user_id = ?
           AND (p.display_name LIKE ? ESCAPE '\\'
             OR p.company LIKE ? ESCAPE '\\'
             OR p.primary_address LIKE ? ESCAPE '\\'
             OR a.address LIKE ? ESCAPE '\\'
             OR a.name LIKE ? ESCAPE '\\'
             OR t.name LIKE ? ESCAPE '\\')
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, pat, pat, pat, pat, pat, pat, lim, off);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM contact_persons WHERE user_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(userId, lim, off);
  }
  const total = q && String(q).trim()
    ? db
        .prepare(
          `SELECT COUNT(DISTINCT p.id) AS n FROM contact_persons p
           LEFT JOIN contact_addresses a ON a.person_id = p.id
           LEFT JOIN contact_tag_map tm ON tm.person_id = p.id
           LEFT JOIN contact_tags t ON t.id = tm.tag_id
           WHERE p.user_id = ?
             AND (p.display_name LIKE ? ESCAPE '\\'
               OR p.company LIKE ? ESCAPE '\\'
               OR p.primary_address LIKE ? ESCAPE '\\'
               OR a.address LIKE ? ESCAPE '\\'
               OR a.name LIKE ? ESCAPE '\\'
               OR t.name LIKE ? ESCAPE '\\')`
        )
        .get(userId, like(String(q).trim()), like(String(q).trim()), like(String(q).trim()), like(String(q).trim()), like(String(q).trim()), like(String(q).trim())).n
    : db.prepare('SELECT COUNT(*) AS n FROM contact_persons WHERE user_id = ?').get(userId).n;
  return { persons: rows.map((r) => publicPerson(r, userId)), total, limit: lim, offset: off };
}

export function createPerson(userId, { displayName, company, note, address, addresses } = {}) {
  const addrs = [];
  if (Array.isArray(addresses) && addresses.length) {
    for (const item of addresses) {
      const a = typeof item === 'string' ? item : item?.address;
      if (validAddress(a)) addrs.push(normAddress(a));
    }
  } else if (validAddress(address)) {
    addrs.push(normAddress(address));
  }
  if (!addrs.length) throw Object.assign(new Error('请填写至少一个邮箱地址'), { status: 400 });
  const primary = addrs[0];
  for (const a of addrs) {
    const clash = db.prepare('SELECT person_id FROM contact_addresses WHERE user_id = ? AND address = ?').get(userId, a);
    if (clash) {
      const other = getPerson(userId, clash.person_id);
      const label = other?.displayName || other?.company || a;
      throw Object.assign(new Error(`该邮箱已属于「${label}」`), { status: 409, personId: clash.person_id });
    }
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM contact_persons WHERE user_id = ?').get(userId).n;
  if (total >= MAX_PERSONS) throw Object.assign(new Error(`最多保存 ${MAX_PERSONS} 个联系人`), { status: 400 });
  const t = now();
  const name = sanitizeName(displayName) || sanitizeName(addrs[0].split('@')[0]) || '';
  const info = db
    .prepare(
      `INSERT INTO contact_persons (user_id, display_name, company, note, primary_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, name, sanitizeName(company, MAX_COMPANY), sanitizeNote(note), primary, t, t);
  const pid = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO contact_addresses (user_id, address, person_id, is_primary, source, name, score, last_at)
     VALUES (?, ?, ?, ?, 'manual', ?, 0, ?)`
  );
  addrs.forEach((a, i) => ins.run(userId, a, pid, i === 0 ? 1 : 0, name, t));
  // 同步旧 contacts 表，保持双写
  for (const a of addrs) {
    db.prepare(
      `INSERT INTO contacts (user_id, address, name, score, last_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
         last_at = excluded.last_at`
    ).run(userId, a, name, t);
  }
  return getPerson(userId, pid);
}

export function updatePerson(userId, id, patch = {}) {
  const row = getRow(userId, id);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  let displayName = row.display_name;
  let company = row.company;
  let note = row.note;
  if (patch.displayName != null) displayName = sanitizeName(patch.displayName);
  if (patch.company != null) company = sanitizeName(patch.company, MAX_COMPANY);
  if (patch.note != null) note = sanitizeNote(patch.note);
  const t = now();
  db.prepare(
    'UPDATE contact_persons SET display_name = ?, company = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(displayName, company, note, t, id, userId);
  return getPerson(userId, id);
}

export function deletePerson(userId, id) {
  const row = getRow(userId, id);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  // 地址级联；不删 messages / sender_rules / 旧 contacts 分数
  db.prepare('DELETE FROM contact_persons WHERE id = ? AND user_id = ?').run(id, userId);
  return { ok: true };
}

export function addAddress(userId, personId, address, { makePrimary = false } = {}) {
  const row = getRow(userId, personId);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  if (!validAddress(address)) throw Object.assign(new Error('邮箱地址不合法'), { status: 400 });
  const addr = normAddress(address);
  const count = db.prepare('SELECT COUNT(*) AS n FROM contact_addresses WHERE person_id = ?').get(personId).n;
  if (count >= MAX_ADDRESSES) throw Object.assign(new Error(`每个联系人最多 ${MAX_ADDRESSES} 个邮箱`), { status: 400 });
  const clash = db.prepare('SELECT person_id FROM contact_addresses WHERE user_id = ? AND address = ?').get(userId, addr);
  if (clash) {
    if (clash.person_id === personId) throw Object.assign(new Error('该邮箱已在此联系人下'), { status: 409 });
    const other = getPerson(userId, clash.person_id);
    const label = other?.displayName || other?.company || addr;
    throw Object.assign(new Error(`该邮箱已属于「${label}」`), { status: 409, personId: clash.person_id });
  }
  const t = now();
  const primary = makePrimary || count === 0;
  if (primary) {
    db.prepare('UPDATE contact_addresses SET is_primary = 0 WHERE person_id = ?').run(personId);
    db.prepare('UPDATE contact_persons SET primary_address = ?, updated_at = ? WHERE id = ?').run(addr, t, personId);
  } else {
    db.prepare('UPDATE contact_persons SET updated_at = ? WHERE id = ?').run(t, personId);
  }
  db.prepare(
    `INSERT INTO contact_addresses (user_id, address, person_id, is_primary, source, name, score, last_at)
     VALUES (?, ?, ?, ?, 'manual', ?, 0, ?)`
  ).run(userId, addr, personId, primary ? 1 : 0, row.display_name || '', t);
  db.prepare(
    `INSERT INTO contacts (user_id, address, name, score, last_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id, address) DO UPDATE SET last_at = excluded.last_at,
     name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`
  ).run(userId, addr, row.display_name || '', t);
  return getPerson(userId, personId);
}

export function removeAddress(userId, personId, address) {
  const row = getRow(userId, personId);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  const addr = normAddress(address);
  const existing = db
    .prepare('SELECT address, is_primary FROM contact_addresses WHERE user_id = ? AND person_id = ? AND address = ?')
    .get(userId, personId, addr);
  if (!existing) throw Object.assign(new Error('地址不存在'), { status: 404 });
  const count = db.prepare('SELECT COUNT(*) AS n FROM contact_addresses WHERE person_id = ?').get(personId).n;
  if (count <= 1) throw Object.assign(new Error('至少保留一个邮箱地址'), { status: 400 });
  db.prepare('DELETE FROM contact_addresses WHERE user_id = ? AND person_id = ? AND address = ?').run(userId, personId, addr);
  const t = now();
  if (existing.is_primary) {
    const next = db
      .prepare('SELECT address FROM contact_addresses WHERE person_id = ? ORDER BY score DESC, last_at DESC LIMIT 1')
      .get(personId);
    if (next) {
      db.prepare('UPDATE contact_addresses SET is_primary = 1 WHERE person_id = ? AND address = ?').run(personId, next.address);
      db.prepare('UPDATE contact_persons SET primary_address = ?, updated_at = ? WHERE id = ?').run(next.address, t, personId);
    }
  } else {
    db.prepare('UPDATE contact_persons SET updated_at = ? WHERE id = ?').run(t, personId);
  }
  return getPerson(userId, personId);
}

export function setPrimaryAddress(userId, personId, address) {
  const row = getRow(userId, personId);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  const addr = normAddress(address);
  const existing = db
    .prepare('SELECT 1 FROM contact_addresses WHERE user_id = ? AND person_id = ? AND address = ?')
    .get(userId, personId, addr);
  if (!existing) throw Object.assign(new Error('地址不存在'), { status: 404 });
  const t = now();
  db.prepare('UPDATE contact_addresses SET is_primary = 0 WHERE person_id = ?').run(personId);
  db.prepare('UPDATE contact_addresses SET is_primary = 1 WHERE person_id = ? AND address = ?').run(personId, addr);
  db.prepare('UPDATE contact_persons SET primary_address = ?, updated_at = ? WHERE id = ?').run(addr, t, personId);
  return getPerson(userId, personId);
}

/** 合并 from → to：挪地址与客户标签，删除 from */
export function mergePersons(userId, fromId, toId) {
  fromId = Number(fromId);
  toId = Number(toId);
  if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId) {
    throw Object.assign(new Error('请选择两个不同的联系人'), { status: 400 });
  }
  const from = getRow(userId, fromId);
  const to = getRow(userId, toId);
  if (!from || !to) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  const t = now();
  const run = tx(() => {
    const addrs = db.prepare('SELECT * FROM contact_addresses WHERE person_id = ?').all(fromId);
    const toCount = db.prepare('SELECT COUNT(*) AS n FROM contact_addresses WHERE person_id = ?').get(toId).n;
    if (toCount + addrs.length > MAX_ADDRESSES) {
      throw Object.assign(new Error(`合并后邮箱数超过 ${MAX_ADDRESSES} 个上限`), { status: 400 });
    }
    for (const a of addrs) {
      db.prepare('UPDATE contact_addresses SET person_id = ?, is_primary = 0 WHERE user_id = ? AND address = ?').run(
        toId,
        userId,
        a.address
      );
    }
    const tags = db.prepare('SELECT tag_id FROM contact_tag_map WHERE person_id = ?').all(fromId);
    const insTag = db.prepare(
      'INSERT OR IGNORE INTO contact_tag_map (person_id, tag_id, created_at) VALUES (?, ?, ?)'
    );
    for (const tg of tags) insTag.run(toId, tg.tag_id, t);
    if (!to.company && from.company) {
      db.prepare('UPDATE contact_persons SET company = ? WHERE id = ?').run(from.company, toId);
    }
    if (!to.note && from.note) {
      db.prepare('UPDATE contact_persons SET note = ? WHERE id = ?').run(from.note, toId);
    }
    if (!to.display_name && from.display_name) {
      db.prepare('UPDATE contact_persons SET display_name = ? WHERE id = ?').run(from.display_name, toId);
    }
    db.prepare('DELETE FROM contact_persons WHERE id = ? AND user_id = ?').run(fromId, userId);
    db.prepare('UPDATE contact_persons SET updated_at = ? WHERE id = ?').run(t, toId);
  });
  run();
  return getPerson(userId, toId);
}

export function resolveByAddress(userId, address) {
  const addr = normAddress(address);
  if (!addr) return { person: null, auto: null };
  const row = db
    .prepare(
      `SELECT p.* FROM contact_addresses a
       JOIN contact_persons p ON p.id = a.person_id
       WHERE a.user_id = ? AND a.address = ?`
    )
    .get(userId, addr);
  if (row) return { person: publicPerson(row, userId), auto: null };
  const auto = db.prepare('SELECT address, name, score, last_at AS lastAt FROM contacts WHERE user_id = ? AND address = ?').get(userId, addr);
  return {
    person: null,
    auto: auto ? { address: auto.address, name: auto.name || '', score: auto.score || 0, lastAt: auto.lastAt || null } : null,
  };
}

/** 往来触达：双写旧 contacts + Person 地址（自动建单地址 Person） */
export const touchAddresses = tx((userId, list, weight = 1) => {
  const upOld = db.prepare(
    `INSERT INTO contacts (user_id, address, name, score, last_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, address) DO UPDATE SET score = score + excluded.score, last_at = excluded.last_at,
     name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`
  );
  const findAddr = db.prepare('SELECT person_id FROM contact_addresses WHERE user_id = ? AND address = ?');
  const bump = db.prepare(
    `UPDATE contact_addresses SET score = score + ?, last_at = ?,
     name = CASE WHEN ? != '' THEN ? ELSE name END WHERE user_id = ? AND address = ?`
  );
  const touchPerson = db.prepare('UPDATE contact_persons SET updated_at = ? WHERE id = ?');
  const insPerson = db.prepare(
    `INSERT INTO contact_persons (user_id, display_name, company, note, primary_address, created_at, updated_at)
     VALUES (?, ?, '', '', ?, ?, ?)`
  );
  const insAddr = db.prepare(
    `INSERT INTO contact_addresses (user_id, address, person_id, is_primary, source, name, score, last_at)
     VALUES (?, ?, ?, 1, 'auto', ?, ?, ?)`
  );
  const t = now();
  for (const c of list) {
    const address = normAddress(c?.address);
    if (!validAddress(address)) continue;
    const name = String(c.name || '').replace(/^"|"$/g, '').trim().slice(0, MAX_NAME);
    upOld.run(userId, address, name, weight, t);
    const existing = findAddr.get(userId, address);
    if (existing) {
      bump.run(weight, t, name, name, userId, address);
      touchPerson.run(t, existing.person_id);
    } else {
      const info = insPerson.run(userId, name, address, t, t);
      insAddr.run(userId, address, Number(info.lastInsertRowid), name, weight, t);
    }
  }
});

/** Composer 联想：从 Person 地址展开，兼容 { address, name } */
export function searchContactsFlat(userId, q) {
  const pat = like(String(q || '').trim() || '');
  const empty = !String(q || '').trim();
  if (empty) {
    return db
      .prepare(
        `SELECT a.address,
           COALESCE(NULLIF(p.display_name, ''), NULLIF(a.name, ''), '') AS name
         FROM contact_addresses a
         JOIN contact_persons p ON p.id = a.person_id
         WHERE a.user_id = ?
         ORDER BY a.score DESC, a.last_at DESC LIMIT 8`
      )
      .all(userId);
  }
  return db
    .prepare(
      `SELECT a.address,
         COALESCE(NULLIF(p.display_name, ''), NULLIF(a.name, ''), '') AS name
       FROM contact_addresses a
       JOIN contact_persons p ON p.id = a.person_id
       WHERE a.user_id = ?
         AND (a.address LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\'
           OR p.display_name LIKE ? ESCAPE '\\' OR p.company LIKE ? ESCAPE '\\')
       ORDER BY a.score DESC, a.last_at DESC LIMIT 8`
    )
    .all(userId, pat, pat, pat, pat);
}

export function isKnownContact(userId, address) {
  const addr = normAddress(address);
  if (!addr) return false;
  const row = db.prepare('SELECT score FROM contact_addresses WHERE user_id = ? AND address = ?').get(userId, addr);
  if (row && row.score >= 2) return true;
  return !!db.prepare('SELECT 1 FROM contacts WHERE user_id = ? AND address = ? AND score >= 2').get(userId, addr);
}

export function recentForPerson(userId, personId, limit = 5) {
  const addrs = db.prepare('SELECT address FROM contact_addresses WHERE person_id = ?').all(personId).map((r) => r.address);
  if (!addrs.length) return [];
  const placeholders = addrs.map(() => '?').join(',');
  const lim = Math.min(Math.max(Number(limit) || 5, 1), 20);
  return db
    .prepare(
      `SELECT m.id, m.subject, m.date, m.from_addr AS fromAddr
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ?
         AND lower(m.from_addr) IN (${placeholders})
         AND IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
       ORDER BY m.date DESC LIMIT ?`
    )
    .all(userId, ...addrs.map((a) => a.toLowerCase()), lim)
    .map((r) => ({
      id: r.id,
      subject: r.subject || '(无主题)',
      date: r.date,
      fromAddr: r.fromAddr,
    }));
}

// ---------- 客户标签 ----------
export function listContactTags(userId) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, t.created_at AS createdAt,
        (SELECT COUNT(*) FROM contact_tag_map m WHERE m.tag_id = t.id) AS count
       FROM contact_tags t WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(userId);
}

export function createContactTag(userId, { name, color } = {}) {
  const n = sanitizeName(name, 40);
  if (!n) throw Object.assign(new Error('请输入标签名称'), { status: 400 });
  const total = db.prepare('SELECT COUNT(*) AS n FROM contact_tags WHERE user_id = ?').get(userId).n;
  if (total >= MAX_TAGS) throw Object.assign(new Error(`最多创建 ${MAX_TAGS} 个客户标签`), { status: 400 });
  const exists = db.prepare('SELECT id FROM contact_tags WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, n);
  if (exists) throw Object.assign(new Error('已有同名客户标签'), { status: 409 });
  const info = db
    .prepare('INSERT INTO contact_tags (user_id, name, color, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, n, sanitizeColor(color), now());
  return listContactTags(userId).find((t) => t.id === Number(info.lastInsertRowid));
}

export function deleteContactTag(userId, id) {
  const row = db.prepare('SELECT id FROM contact_tags WHERE user_id = ? AND id = ?').get(userId, id);
  if (!row) throw Object.assign(new Error('客户标签不存在'), { status: 404 });
  db.prepare('DELETE FROM contact_tags WHERE id = ? AND user_id = ?').run(id, userId);
  return { ok: true, tags: listContactTags(userId) };
}

export function applyContactTagPresets(userId) {
  const created = [];
  const skipped = [];
  for (const p of TRADE_CONTACT_TAG_PRESETS) {
    const exists = db.prepare('SELECT id, name FROM contact_tags WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, p.name);
    if (exists) {
      skipped.push(exists.name);
      continue;
    }
    try {
      created.push(createContactTag(userId, p));
    } catch (e) {
      if (e.status === 400 && /最多/.test(e.message)) break;
      skipped.push(p.name);
    }
  }
  return { created, skipped, tags: listContactTags(userId) };
}

export function setPersonTags(userId, personId, { add = [], remove = [] } = {}) {
  const row = getRow(userId, personId);
  if (!row) throw Object.assign(new Error('联系人不存在'), { status: 404 });
  const t = now();
  const run = tx(() => {
    for (const id of remove) {
      db.prepare('DELETE FROM contact_tag_map WHERE person_id = ? AND tag_id = ?').run(personId, Number(id));
    }
    for (const raw of add) {
      let tagId = Number(raw);
      if (!Number.isInteger(tagId)) continue;
      const tag = db.prepare('SELECT id FROM contact_tags WHERE user_id = ? AND id = ?').get(userId, tagId);
      if (!tag) continue;
      const cur = db.prepare('SELECT COUNT(*) AS n FROM contact_tag_map WHERE person_id = ?').get(personId).n;
      const has = db.prepare('SELECT 1 FROM contact_tag_map WHERE person_id = ? AND tag_id = ?').get(personId, tagId);
      if (!has && cur >= MAX_TAGS_PER_PERSON) {
        throw Object.assign(new Error(`每个联系人最多 ${MAX_TAGS_PER_PERSON} 个标签`), { status: 400 });
      }
      db.prepare('INSERT OR IGNORE INTO contact_tag_map (person_id, tag_id, created_at) VALUES (?, ?, ?)').run(personId, tagId, t);
    }
    db.prepare('UPDATE contact_persons SET updated_at = ? WHERE id = ?').run(t, personId);
  });
  run();
  return getPerson(userId, personId);
}
