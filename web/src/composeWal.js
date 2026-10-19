/**
 * 写信本地 WAL：离线/自动保存失败时保住正文，避免飞机上改报价丢稿。
 * 不存附件二进制（体积与配额）；附件名记在 fileNames 作提示。
 */
const KEY = 'zm_compose_wal_v1';
const MAX = 4;
const MAX_BODY = 400_000;

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

export function composeWalLength() {
  return load().length;
}

export function peekComposeWal() {
  return load();
}

/** 取最近一条有内容的快照（启动恢复用） */
export function latestComposeWal() {
  const list = load();
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && (e.to || e.subject || e.body)) return e;
  }
  return null;
}

export function clearComposeWal(walKey) {
  if (walKey == null) {
    save([]);
    return;
  }
  save(load().filter((e) => e.walKey !== String(walKey)));
}

/**
 * @param {{ walKey: string|number, mailboxId?: any, mode?: string, to?: string, cc?: string, bcc?: string, subject?: string, body?: string, draftUid?: any, sourceId?: any, fileNames?: string[] }} entry
 */
export function writeComposeWal(entry) {
  if (!entry?.walKey) return false;
  const body = String(entry.body || '').slice(0, MAX_BODY);
  const row = {
    walKey: String(entry.walKey),
    at: Date.now(),
    mailboxId: entry.mailboxId || null,
    mode: entry.mode || 'new',
    to: String(entry.to || '').slice(0, 2000),
    cc: String(entry.cc || '').slice(0, 2000),
    bcc: String(entry.bcc || '').slice(0, 2000),
    subject: String(entry.subject || '').slice(0, 500),
    body,
    draftUid: entry.draftUid || null,
    sourceId: entry.sourceId || null,
    fileNames: Array.isArray(entry.fileNames) ? entry.fileNames.map(String).slice(0, 20) : [],
  };
  if (!row.to && !row.subject && !row.body.replace(/<[^>]+>/g, '').replace(/\s|&nbsp;/gi, '')) return false;
  const q = load().filter((e) => e.walKey !== row.walKey);
  q.push(row);
  save(q);
  return true;
}

/** 把 WAL 条目变成 Composer initial 补丁 */
export function walToComposeInitial(wal, base = {}) {
  if (!wal) return base;
  return {
    ...base,
    mode: wal.mode || base.mode || 'new',
    mailboxId: wal.mailboxId || base.mailboxId,
    to: wal.to || '',
    cc: wal.cc || '',
    bcc: wal.bcc || '',
    subject: wal.subject || '',
    body: wal.body || base.body,
    draftUid: wal.draftUid || base.draftUid,
    sourceId: wal.sourceId || base.sourceId,
    _fromWal: true,
    _walFileNames: wal.fileNames || [],
  };
}
