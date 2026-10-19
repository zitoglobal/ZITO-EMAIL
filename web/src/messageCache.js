/**
 * 读信正文 LRU：J/K 预取与 Reader 共用，避免换封时丢掉刚拉到的 body。
 */
const MAX = 48;
const cache = new Map();

function touch(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

export function putMessageCache(id, data) {
  const mid = Number(id);
  if (!Number.isInteger(mid) || !data || data.error) return;
  touch(mid, { data, at: Date.now() });
}

export function getMessageCache(id) {
  const mid = Number(id);
  if (!Number.isInteger(mid)) return null;
  const hit = cache.get(mid);
  if (!hit) return null;
  touch(mid, hit);
  return hit.data;
}

export function clearMessageCache() {
  cache.clear();
}
