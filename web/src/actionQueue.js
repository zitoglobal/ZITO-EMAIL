/**
 * 离线操作队列：归档/已处理等乐观更新后落本地，联网再刷。
 * 非 offline 失败保留条目（带 retries / lastError），达上限再丢弃。
 */
const KEY = 'zm_action_queue_v1';
const MAX = 80;
const MAX_RETRIES = 5;

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

export function peekActionQueue() {
  return load();
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
    retries: 0,
    lastError: '',
  });
  save(q);
  return true;
}

/**
 * 顺序刷队列。
 * - 离线：中断并保留剩余（含当前项）
 * - 其他错误：写回 left（retries++），超过 MAX_RETRIES 记入 dropped
 */
export async function flushActionQueue(apiFn) {
  const q = load();
  if (!q.length) return { ok: 0, fail: 0, left: 0, dropped: 0 };
  const left = [];
  let ok = 0;
  let fail = 0;
  let dropped = 0;
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
      const retries = (Number(item.retries) || 0) + 1;
      const lastError = String(e?.message || '同步失败').slice(0, 160);
      if (retries >= MAX_RETRIES) {
        dropped += 1;
      } else {
        left.push({ ...item, retries, lastError });
      }
    }
  }
  save(left);
  return { ok, fail, left: left.length, dropped };
}
