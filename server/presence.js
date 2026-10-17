/**
 * 读信「同事正在看」：内存态，90 秒无心跳过期。
 */
import { emitAll } from './events.js';

const TTL = 90_000;
/** @type {Map<number, Map<number, { name: string, at: number, threadId: string|null }>>} */
const byMessage = new Map();

function pruneMessage(mid, t = Date.now()) {
  const m = byMessage.get(mid);
  if (!m) return;
  for (const [uid, v] of m) if (t - v.at > TTL) m.delete(uid);
  if (!m.size) byMessage.delete(mid);
}

export function touch(userId, name, messageId, threadId = null) {
  const mid = Number(messageId);
  const uid = Number(userId);
  if (!Number.isInteger(mid) || !Number.isInteger(uid)) return [];
  const t = Date.now();
  if (!byMessage.has(mid)) byMessage.set(mid, new Map());
  byMessage.get(mid).set(uid, { name: String(name || '').slice(0, 40), at: t, threadId: threadId || null });
  pruneMessage(mid, t);
  const viewers = list(mid, uid);
  emitAll('presence', { messageId: mid, threadId: threadId || null, viewers });
  return viewers;
}

export function leave(userId, messageId) {
  const mid = Number(messageId);
  const uid = Number(userId);
  const m = byMessage.get(mid);
  if (!m) return [];
  m.delete(uid);
  if (!m.size) byMessage.delete(mid);
  const viewers = list(mid, uid);
  emitAll('presence', { messageId: mid, viewers });
  return viewers;
}

export function list(messageId, excludeUserId = null) {
  const mid = Number(messageId);
  pruneMessage(mid);
  const m = byMessage.get(mid);
  if (!m) return [];
  const ex = excludeUserId != null ? Number(excludeUserId) : null;
  return [...m.entries()]
    .filter(([uid]) => uid !== ex)
    .map(([userId, v]) => ({ userId, name: v.name, at: v.at }));
}

setInterval(() => {
  const t = Date.now();
  for (const mid of [...byMessage.keys()]) pruneMessage(mid, t);
}, 30_000).unref();
