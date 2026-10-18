import { db, now } from './db.js';
import { resolveScopes } from './deals.js';

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
    previewUrl: `/api/messages/${r.message_id}/attachments/${r.att_index}?inline=1`,
    downloadUrl: `/api/messages/${r.message_id}/attachments/${r.att_index}`,
  };
}

export function listAssets(userId, { address, scopeKey, limit = 50 } = {}) {
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
  const uniq = [...new Set(keys)];
  const ph = uniq.map(() => '?').join(',');
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT * FROM customer_assets WHERE user_id = ? AND scope_key IN (${ph})
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, ...uniq, lim)
    .map(publicAsset);
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
  if (dup) return publicAsset(db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(dup.id));

  const id = Number(
    db
      .prepare(
        `INSERT INTO customer_assets
          (user_id, scope_key, kind, title, message_id, att_index, filename, content_type, style_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, scopeKey, kind, title, messageId, attIndex, filename, contentType, styleNo, now()).lastInsertRowid
  );
  return publicAsset(db.prepare('SELECT * FROM customer_assets WHERE id = ?').get(id));
}

export function deleteAsset(userId, id) {
  const r = db.prepare('SELECT * FROM customer_assets WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw Object.assign(new Error('资料不存在'), { status: 404 });
  db.prepare('DELETE FROM customer_assets WHERE id = ?').run(id);
  return { ok: true };
}
