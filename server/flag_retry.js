/**
 * IMAP 旗标（已读/星标）失败重试：瞬时网络错误排队重试，不立刻标邮箱 error。
 */
import * as imap from './imap.js';
import * as repo from './repo.js';
import * as sync from './sync.js';
import { emit } from './events.js';

/** @type {{ mbId: number, folder: string, uids: number[], flags: object, tries: number, nextAt: number }[]} */
const queue = [];
const MAX_TRIES = 5;

export function isAuthImapError(e) {
  return imap.isAuthFailure(e);
}

export function isTransientImapError(e) {
  return imap.isTransientFailure(e);
}

export function enqueueFlagRetry(mb, folder, uids, flags) {
  if (!mb?.id || !folder || !uids?.length) return;
  const uniq = [...new Set(uids.map(Number).filter((n) => Number.isInteger(n)))];
  if (!uniq.length) return;
  const keyFlags = JSON.stringify(flags || {});
  const existing = queue.find((j) => j.mbId === mb.id && j.folder === folder && JSON.stringify(j.flags) === keyFlags);
  if (existing) {
    existing.uids = [...new Set([...existing.uids, ...uniq])];
    existing.nextAt = Math.min(existing.nextAt, Date.now() + 1500);
    return;
  }
  queue.push({
    mbId: mb.id,
    folder,
    uids: uniq,
    flags: { ...flags },
    tries: 0,
    nextAt: Date.now() + 1500,
  });
}

function markError(mb, msg) {
  try {
    repo.setMailboxStatus(mb.id, 'error', msg);
    emit(mb.user_id, 'mailbox', { id: mb.id, status: 'error', error: msg });
    emit(mb.user_id, 'sync', { mailboxId: mb.id, local: true });
  } catch {
    /* ignore */
  }
}

async function flushOne(job) {
  const mb = repo.getMailboxById(job.mbId);
  if (!mb) return;
  try {
    await imap.setFlags(mb, job.folder, job.uids, job.flags);
    sync.touch(mb.id, job.folder, 400);
  } catch (e) {
    const msg = imap.friendlyImapError(e);
    if (isAuthImapError(e) || job.tries + 1 >= MAX_TRIES) {
      console.warn('[flag-retry] give up', mb.email, msg);
      markError(mb, msg);
      return;
    }
    job.tries += 1;
    job.nextAt = Date.now() + Math.min(60_000, 2000 * 2 ** job.tries);
    queue.push(job);
    console.warn('[flag-retry] retry', job.tries, mb.email, msg);
  }
}

export function startFlagRetryScheduler() {
  setInterval(() => {
    const now = Date.now();
    const due = [];
    const later = [];
    for (const j of queue.splice(0, queue.length)) {
      (j.nextAt <= now ? due : later).push(j);
    }
    queue.push(...later);
    for (const j of due.slice(0, 8)) flushOne(j).catch(() => {});
  }, 1500).unref();
}
