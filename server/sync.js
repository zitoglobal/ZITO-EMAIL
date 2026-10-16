import * as imap from './imap.js';
import * as repo from './repo.js';
import { emit } from './events.js';
import { now } from './db.js';
import * as priority from './priority.js';
import * as mailRules from './mail_rules.js';
import * as push from './push.js';
import * as users from './users.js';

const SYNC_SPECIALS = ['\\Inbox', '\\Sent', '\\Drafts', '\\Archive', '\\Junk', '\\Trash'];
const INITIAL_INBOX = 400;
const INITIAL_OTHER = 150;
const FULL_INTERVAL = 5 * 60_000;
const INBOX_INTERVAL = 90_000;

/** @type {Map<string, Engine>} */
const engines = new Map();

class Engine {
  constructor(id) {
    this.id = id;
    this.chain = Promise.resolve();
    this.watcher = null;
    this.stopped = false;
    this.retry = 0;
    this.debounce = new Map();
    this.timers = [];
  }

  get mb() {
    return repo.getMailboxById(this.id);
  }

  inboxPath() {
    return repo.specialFolder(this.id, '\\Inbox')?.path || 'INBOX';
  }

  start() {
    this.full();
    this.timers.push(setInterval(() => this.full(), FULL_INTERVAL));
    this.timers.push(setInterval(() => this.syncFolder(this.inboxPath()).catch(() => {}), INBOX_INTERVAL));
    this.connectWatcher();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.reconnectTimer);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.watcher?.logout().catch(() => {});
    this.watcher = null;
    imap.dropClient(this.id);
  }

  /** 同一邮箱的同步任务串行执行，避免抢占文件夹锁 */
  enqueue(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  later(path, ms = 800) {
    clearTimeout(this.debounce.get(path));
    this.debounce.set(
      path,
      setTimeout(() => {
        this.debounce.delete(path);
        this.syncFolder(path).catch(() => {});
      }, ms)
    );
  }

  async connectWatcher() {
    if (this.stopped) return;
    const mb = this.mb;
    if (!mb) return this.stop();
    const client = imap.buildClient(mb);
    client.on('exists', () => this.later(this.inboxPath()));
    client.on('expunge', () => this.later(this.inboxPath(), 1500));
    client.on('flags', (ev) => {
      if (!ev?.uid || !ev.flags) return this.later(this.inboxPath(), 1500);
      repo.applyFlagChanges(mb.id, ev.path, [
        { uid: ev.uid, seen: ev.flags.has('\\Seen'), flagged: ev.flags.has('\\Flagged'), answered: ev.flags.has('\\Answered') },
      ]);
      emit(mb.user_id, 'sync', { mailboxId: mb.id, folder: ev.path });
    });
    client.on('close', () => {
      if (this.watcher === client) this.watcher = null;
      if (this.stopped) return;
      const delay = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(this.retry++, 6));
      this.reconnectTimer = setTimeout(() => this.connectWatcher(), delay);
    });
    try {
      await client.connect();
      await client.mailboxOpen(this.inboxPath());
      this.watcher = client;
      this.retry = 0;
    } catch (e) {
      if (e?.authenticationFailed) {
        this.retry = 10;
        this.markError(imap.friendlyImapError(e));
      }
      client.close();
    }
  }

  markError(message) {
    const mb = this.mb;
    if (!mb) return;
    repo.setMailboxStatus(mb.id, 'error', message);
    emit(mb.user_id, 'mailbox', { id: mb.id, status: 'error', error: message });
  }

  full() {
    return this.enqueue(async () => {
      const mb = this.mb;
      if (!mb) return this.stop();
      // 内置演示邮箱没有真实服务器，不同步
      if (mb.provider === 'demo') return;
      try {
        if (mb.status !== 'ok') emit(mb.user_id, 'mailbox', { id: mb.id, status: 'syncing' });
        repo.replaceFolders(mb.id, await imap.listServerFolders(mb));
        const folders = repo.listFolders(mb.id);
        const targets = folders.filter((f) => SYNC_SPECIALS.includes(f.special_use) || f.last_sync);
        targets.sort((a, b) => (a.special_use === '\\Inbox' ? -1 : b.special_use === '\\Inbox' ? 1 : 0));
        for (const f of targets) await this.syncFolderNow(mb, f.path);
        repo.setMailboxStatus(mb.id, 'ok');
        emit(mb.user_id, 'mailbox', { id: mb.id, status: 'ok' });
        if (!this.watcher && !this.reconnectTimer) this.connectWatcher();
      } catch (e) {
        this.markError(e.message || String(e));
      }
    });
  }

  syncFolder(path) {
    return this.enqueue(async () => {
      const mb = this.mb;
      if (!mb) return;
      if (!repo.getFolder(mb.id, path)) return;
      await this.syncFolderNow(mb, path);
    });
  }

  async syncFolderNow(mb, path) {
    const folderRow = repo.getFolder(mb.id, path);
    if (!folderRow) return;
    const firstSync = !folderRow.last_sync;
    const isInbox = folderRow.special_use === '\\Inbox';
    const useWatcher = isInbox && this.watcher?.usable ? this.watcher : undefined;

    const inserted = await imap.withBox(
      mb,
      path,
      async (c) => {
        await c.noop().catch(() => {});
        const box = c.mailbox;
        const validity = String(box.uidValidity ?? '');
        if (folderRow.uidvalidity && folderRow.uidvalidity !== validity) repo.clearFolderMessages(mb.id, path);
        const exists = box.exists || 0;
        let added = [];

        if (exists > 0) {
          const max = repo.maxUid(mb.id, path);
          let items = [];
          if (!max) {
            const n = isInbox ? INITIAL_INBOX : INITIAL_OTHER;
            items = await imap.fetchEnvelopes(c, `${Math.max(1, exists - n + 1)}:*`, { uid: false });
          } else {
            items = (await imap.fetchEnvelopes(c, `${max + 1}:*`, { uid: true })).filter((m) => m.uid > max);
          }
          added = repo.upsertMessages(mb.id, path, items);

          const min = repo.minUid(mb.id, path);
          if (min) {
            const server = new Map();
            for await (const m of c.fetch(`${min}:*`, { uid: true, flags: true }, { uid: true })) server.set(m.uid, m.flags);
            const changes = [];
            const gone = [];
            let visibleMax = 0;
            for (const u of server.keys()) if (u > visibleMax) visibleMax = u;
            for (const r of repo.cachedUids(mb.id, path)) {
              const f = server.get(r.uid);
              if (!f) {
                // 其他连接刚移入的邮件可能尚未对本会话可见，不能据此判定为已删除
                if (r.uid <= visibleMax) gone.push(r.uid);
                continue;
              }
              const s = { uid: r.uid, seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered') };
              if (s.seen !== !!r.seen || s.flagged !== !!r.flagged || s.answered !== !!r.answered) changes.push(s);
            }
            if (changes.length) repo.applyFlagChanges(mb.id, path, changes);
            if (gone.length) repo.deleteUids(mb.id, path, gone);
          }
        } else {
          repo.clearFolderMessages(mb.id, path);
        }

        const unseen = exists ? ((await c.search({ seen: false }, { uid: true })) || []).length : 0;
        repo.updateFolderState(mb.id, path, { uidvalidity: validity, total: exists, unseen, last_sync: now() });
        return added;
      },
      useWatcher
    );

    if (folderRow.special_use === '\\Sent' && inserted.length) {
      repo.addContacts(mb.user_id, inserted.flatMap((m) => [...m.to, ...m.cc]), 2);
      priority.invalidate(mb.user_id);
    }
    if (isInbox && inserted.length) {
      repo.addContacts(mb.user_id, inserted.filter((m) => m.category === 'people').map((m) => m.from), 1);
    }
    // 邮件规则：仅增量新信；首次全量同步不对历史邮件生效
    if (inserted.length && !firstSync) {
      try {
        const { deferred } = mailRules.applyRulesForInserted(mb.user_id, mb.id, inserted);
        await flushRuleDeferred(mb, deferred);
      } catch (e) {
        console.warn('[mail-rules]', mb.id, e?.message || e);
      }
    }
    emit(mb.user_id, 'sync', { mailboxId: mb.id, folder: path, added: inserted.length });
    if (isInbox && !firstSync) {
      const skipIds = new Set(
        inserted.length
          ? repo
              .getMessagesForUser(mb.user_id, inserted.map((m) => m.id))
              .filter((r) => r.skip_inbox)
              .map((r) => r.id)
          : []
      );
      const fresh = inserted
        .filter((m) => !m.seen && !skipIds.has(m.id))
        .map((m) => ({ id: m.id, subject: m.subject, from: m.from, category: m.category, ...priority.importance(mb.user_id, m) }))
        .sort((a, b) => b.important - a.important);
      if (fresh.length) {
        emit(mb.user_id, 'new', {
          mailboxId: mb.id,
          items: fresh.slice(0, 5),
          count: fresh.length,
          important: fresh.filter((m) => m.important).length,
        });
        try {
          const settings = users.settingsOf(mb.user_id);
          if (settings.notify) {
            const first = fresh[0];
            const important = !!first.important;
            push
              .notifyUser(mb.user_id, {
                title: important ? '重要来信' : '新邮件',
                body:
                  fresh.length > 1
                    ? `${mb.email || ''} 收到 ${fresh.length} 封新邮件`
                    : `${first.from?.name || first.from?.address || ''}：${first.subject || '(无主题)'}`,
                url: '/',
                tag: 'zm-' + mb.id,
                urgency: important ? 'high' : 'normal',
              })
              .catch(() => {});
          }
        } catch {
          /* push optional */
        }
      }
    }
  }

  /** 列表滚动到底部时，从服务器回填更早的邮件 */
  backfill(path, count = 200) {
    return this.enqueue(async () => {
      const mb = this.mb;
      const folderRow = repo.getFolder(mb.id, path);
      if (!folderRow) return 0;
      if (!folderRow.last_sync) {
        await this.syncFolderNow(mb, path);
        return repo.countCached(mb.id, path);
      }
      const min = repo.minUid(mb.id, path);
      if (min <= 1) return 0;
      return imap.withBox(mb, path, async (c) => {
        const uids = ((await c.search({ uid: `1:${min - 1}` }, { uid: true })) || []).map(Number).sort((a, b) => a - b);
        const take = uids.slice(-count);
        if (!take.length) return 0;
        const items = await imap.fetchEnvelopes(c, take.join(','), { uid: true });
        return repo.upsertMessages(mb.id, path, items).length;
      });
    });
  }
}


/** 执行规则引擎产生的 IMAP 副作用（标旗 / 移动） */
async function flushRuleDeferred(mb, deferred = []) {
  if (!deferred?.length) return;
  const flagGroups = new Map();
  const moves = [];
  for (const d of deferred) {
    if (!d || d.mailboxId !== mb.id) continue;
    if (d.kind === 'flags') {
      const key = d.folder + '\0' + JSON.stringify(d.flags || {});
      if (!flagGroups.has(key)) flagGroups.set(key, { folder: d.folder, flags: d.flags, uids: [] });
      flagGroups.get(key).uids.push(d.uid);
    } else if (d.kind === 'move') {
      moves.push(d);
    }
  }
  for (const g of flagGroups.values()) {
    try {
      await imap.setFlags(mb, g.folder, [...new Set(g.uids)], g.flags);
    } catch (_) {}
  }
  for (const m of moves) {
    try {
      if (!repo.getFolder(mb.id, m.dest) || m.dest === m.folder) continue;
      const client = await imap.getClient(mb);
      const lock = await client.getMailboxLock(m.folder);
      let result;
      try {
        result = await client.messageMove(String(m.uid), m.dest, { uid: true });
      } finally {
        lock.release();
      }
      const nu = result?.uidMap?.get?.(m.uid);
      if (nu && m.messageId) {
        repo.patchMessages([m.messageId], { folder: m.dest, uid: nu, snooze_until: null });
      } else if (m.messageId) {
        repo.deleteMessageRows([m.messageId]);
      }
    } catch (_) {}
  }
}

export function ensure(id) {
  let e = engines.get(id);
  if (!e) {
    e = new Engine(id);
    engines.set(id, e);
    e.start();
  }
  return e;
}

export function stop(id) {
  engines.get(id)?.stop();
  engines.delete(id);
}

export function restart(id) {
  stop(id);
  return ensure(id);
}

export function startAll() {
  for (const mb of repo.allMailboxes()) ensure(mb.id);
}

/** 用户操作后的增量刷新 */
export function touch(mailboxId, folder) {
  const e = engines.get(mailboxId);
  if (e && folder) e.later(folder, 1200);
}
