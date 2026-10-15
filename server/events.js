/** @type {Map<number, Set<import('express').Response>>} */
const subs = new Map();

export function subscribe(userId, res) {
  if (!subs.has(userId)) subs.set(userId, new Set());
  subs.get(userId).add(res);
  return () => {
    subs.get(userId)?.delete(res);
    if (!subs.get(userId)?.size) subs.delete(userId);
  };
}

export const isOnline = (userId) => !!subs.get(Number(userId))?.size;

export function emit(userId, type, data = {}) {
  const set = subs.get(Number(userId));
  if (!set) return;
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(line);
    } catch {
      // 连接已断开
    }
  }
}

setInterval(() => {
  for (const set of subs.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();
