/**
 * 离线操作队列：归档/已处理等乐观更新后落本地，联网再刷。
 */
const KEY = 'zm_action_queue_v1';
const MAX = 80;

export const QUEUEABLE_ACTIONS = new Set([
  'archive',
  'trash',
  'spam',
  'done',
  'nofollow',
  'read',
  'unread',
  'flag',
  'unflag',
  'pin',
  'unpin',
  'snooze',
  'unsnooze',
]);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* quota */
  }
}

export function actionQueueLength() {
  return load().length;
}

export function enqueueAction({ ids, action, extra = {} }) {
  if (!QUEUEABLE_ACTIONS.has(action) || !ids?.length) return false;
  const q = load();
  q.push({
    id: Math.random().toString(36).slice(2, 10),
    ids: ids.map(Number).filter(Number.isInteger),
    action,
    extra,
    at: Date.now(),
  });
  save(q);
  return true;
}

/** 顺序刷队列；遇离线中断并保留剩余 */
export async function flushActionQueue(apiFn) {
  const q = load();
  if (!q.length) return { ok: 0, fail: 0, left: 0 };
  const left = [];
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < q.length; i++) {
    const item = q[i];
    try {
      await apiFn('/messages/actions', {
        method: 'POST',
        body: { ids: item.ids, action: item.action, ...item.extra },
      });
      ok += 1;
    } catch (e) {
      if (e?.offline || e?.status === 0) {
        left.push(...q.slice(i));
        break;
      }
      fail += 1;
    }
  }
  save(left);
  return { ok, fail, left: left.length };
}
