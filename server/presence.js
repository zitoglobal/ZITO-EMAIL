/**
 * 读信「同事正在看」：内存态，90 秒无心跳过期。
 * 同 messageId 或同 threadId 的观众互相可见（不再全域广播）。
 */
import { emit } from './events.js';

const TTL = 90_000;
/** @type {Map<number, Map<number, { name: string, at: number, threadId: string|null }>>} */
const byMessage = new Map();

function pruneMessage(mid, t = Date.now()) {
  const m = byMessage.get(mid);
  if (!m) return;
  for (const [uid, v] of m) if (t - v.at > TTL) m.delete(uid);
  if (!m.size) byMessage.delete(mid);
}

function collectThreadUserIds(threadId, mid) {
  const ids = new Set();
  const tid = threadId ? String(threadId) : '';
  if (tid) {
    for (const [otherMid, m] of byMessage) {
      for (const [uid, v] of m) {
        if (v.threadId && String(v.threadId) === tid) ids.add(uid);
        else if (otherMid === mid) ids.add(uid);
      }
    }
  }
  const m = byMessage.get(mid);
  if (m) for (const uid of m.keys()) ids.add(uid);
  return ids;
}

function emitPresence(mid, threadId, payload, extraUserIds = []) {
  const ids = collectThreadUserIds(threadId, mid);
  for (const uid of extraUserIds) {
    const n = Number(uid);
    if (Number.isInteger(n)) ids.add(n);
  }
  for (const uid of ids) emit(uid, 'presence', payload);
}

/**
 * 合并同线程其它邮件上的观众（排除自己）
 */
export function list(messageId, excludeUserId = null, threadId = null) {
  const mid = Number(messageId);
  const t = Date.now();
  pruneMessage(mid, t);
  const tid = threadId ? String(threadId) : null;
  /** @type {Map<number, { userId: number, name: string, at: number }>} */
  const byUser = new Map();

  const absorb = (map) => {
    if (!map) return;
    for (const [id, v] of map) {
      if (t - v.at > TTL) continue;
      if (excludeUserId != null && id === Number(excludeUserId)) continue;
      const prev = byUser.get(id);
      if (!prev || v.at > prev.at) byUser.set(id, { userId: id, name: v.name, at: v.at });
    }
  };

  absorb(byMessage.get(mid));
  if (tid) {
    for (const [otherMid, map] of byMessage) {
      if (otherMid === mid) continue;
      pruneMessage(otherMid, t);
      let hit = false;
      for (const v of map.values()) {
        if (v.threadId && String(v.threadId) === tid) {
          hit = true;
          break;
        }
      }
      if (hit) absorb(map);
    }
  }

  return [...byUser.values()].sort((a, b) => b.at - a.at);
}

export function touch(userId, name, messageId, threadId = null) {
  const mid = Number(messageId);
  const uid = Number(userId);
  if (!Number.isInteger(mid) || !Number.isInteger(uid)) return [];
  const t = Date.now();
  if (!byMessage.has(mid)) byMessage.set(mid, new Map());
  byMessage.get(mid).set(uid, { name: String(name || '').slice(0, 40), at: t, threadId: threadId || null });
  pruneMessage(mid, t);
  const viewers = list(mid, uid, threadId);
  emitPresence(mid, threadId, { messageId: mid, threadId: threadId || null, viewers }, [uid]);
  return viewers;
}

export function leave(userId, messageId) {
  const mid = Number(messageId);
  const uid = Number(userId);
  const m = byMessage.get(mid);
  if (!m) return [];
  const threadId = m.get(uid)?.threadId || null;
  m.delete(uid);
  if (!m.size) byMessage.delete(mid);
  const viewers = list(mid, uid, threadId);
  emitPresence(mid, threadId, { messageId: mid, threadId, viewers }, [uid]);
  return viewers;
}

setInterval(() => {
  const t = Date.now();
  for (const mid of [...byMessage.keys()]) pruneMessage(mid, t);
}, 30_000).unref();
