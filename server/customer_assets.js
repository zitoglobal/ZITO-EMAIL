import { db, now } from './db.js';
import { assertScopeReadable, resolveScopes } from './deals.js';

const KINDS = new Set(['techpack', 'swatch', 'sizechart', 'other']);

function publicAsset(r) {
  return {
    id: r.id,
    userId: r.user_id,
    scopeKey: r.scope_key,
    kind: r.kind,
    title: r.title,
    messageId: r.message_id,
    attIndex: r.att_index,
    filename: r.filename,
    contentType: r.content_type,
    styleNo: r.style_no || '',
    createdAt: r.created_at,
    mine: false,
    // 走资料库代理，认领范围内同事可打开（不依赖本箱是否有该邮件）
    previewUrl: `/api/customer-assets/${r.id}/content?inline=1`,
    downloadUrl: `/api/customer-assets/${r.id}/content`,
  };
}

function scopeKeysFor(address, scopeKey) {
  let sk = scopeKey;
  if (!sk && address) {
    const scopes = resolveScopes(address);
    if (!scopes) return [];
    sk = scopes.default.key;
  }
  if (!sk) return [];
  const keys = [sk];
  if (address) {
    const scopes = resolveScopes(address);
    if (scopes?.person) keys.push(scopes.person.key);
    if (scopes?.company) keys.push(scopes.company.key);
  }
  return [...new Set(keys)];
}

/**
 * 认领范围内团队可读：按 scope_key 列资料，不限上传者。
 * 预览/下载走 /api/customer-assets/:id/content 代理。
 */
export function listAssets(userId, { address, scopeKey, limit = 50 } = {}) {
  const uniq = scopeKeysFor(address, scopeKey);
  if (!uniq.length) return [];
  const ph = uniq.map(() => '?').join(',');
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT * FROM customer_assets WHERE scope_key IN (${ph})
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...uniq, lim)
    .map((r) => {
      const a = publicAsset(r);
      a.mine = r.user_id === userId;
      return a;
    });
}

export function getAsset(id) {
  return db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(Number(id));
}

/** 校验可读后返回行（含原邮件定位信息） */
export function assertAssetReadable(userId, assetId) {
  const r = getAsset(assetId);
  if (!r) throw Object.assign(new Error('资料不存在'), { status: 404 });
  assertScopeReadable(userId, r.scope_key);
  return r;
}

/** 解析资料对应的邮件行（跨上传者邮箱，供 IMAP 取附件） */
export function messageRowForAsset(asset) {
  if (!asset) return null;
  return db
    .prepare(
      `SELECT m.id, m.mailbox_id, m.folder, m.uid, m.subject
       FROM messages m WHERE m.id = ?`
    )
    .get(asset.message_id);
}

export function addAsset(userId, body = {}) {
  const messageId = Number(body.messageId);
  const attIndex = Number(body.attIndex);
  if (!Number.isInteger(messageId) || !Number.isInteger(attIndex) || attIndex < 0) {
    throw Object.assign(new Error('请指定邮件附件'), { status: 400 });
  }
  const msg = db
    .prepare(
      `SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.id = ? AND b.user_id = ?`
    )
    .get(messageId, userId);
  if (!msg) throw Object.assign(new Error('邮件不存在或无权访问'), { status: 404 });

  let scopeKey = String(body.scopeKey || '').trim();
  if (!scopeKey) {
    const scopes = resolveScopes(body.address);
    if (!scopes) throw Object.assign(new Error('请指定客户地址'), { status: 400 });
    scopeKey = scopes.default.key;
  }
  const kind = KINDS.has(body.kind) ? body.kind : 'other';
  const title = String(body.title || body.filename || '资料').trim().slice(0, 120);
  const filename = String(body.filename || '').trim().slice(0, 200);
  const contentType = String(body.contentType || '').trim().slice(0, 120);
  const styleNo = String(body.styleNo || '').trim().slice(0, 80);

  const dup = db
    .prepare(
      `SELECT id FROM customer_assets WHERE user_id = ? AND message_id = ? AND att_index = ? AND scope_key = ?`
    )
    .get(userId, messageId, attIndex, scopeKey);
  if (dup) {
    const a = publicAsset(db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(dup.id));
    a.mine = true;
    return a;
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO customer_assets
          (user_id, scope_key, kind, title, message_id, att_index, filename, content_type, style_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, scopeKey, kind, title, messageId, attIndex, filename, contentType, styleNo, now()).lastInsertRowid
  );
  const a = publicAsset(db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(id));
  a.mine = true;
  return a;
}

export function deleteAsset(userId, id, { admin = false } = {}) {
  const r = db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(id);
  if (!r) throw Object.assign(new Error('资料不存在'), { status: 404 });
  if (r.user_id !== userId && !admin) {
    throw Object.assign(new Error('只能删除自己收入的资料'), { status: 403 });
  }
  db.prepare('DELETE FROM customer_assets WHERE id = ?').run(id);
  return { ok: true };
}
