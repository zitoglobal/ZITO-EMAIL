import { db, now, tx } from './db.js';
import { signalsOf } from './classify.js';

// ---------- 邮箱 ----------
export const getMailbox = (userId, id) => db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(id, userId);
export const getMailboxById = (id) => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
export const listMailboxes = (userId) => db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY sort, created_at').all(userId);
export const allMailboxes = () => db.prepare('SELECT * FROM mailboxes').all();

export function publicMailbox(m) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    color: m.color,
    provider: m.provider,
    providerName: m.provider_name,
    signature: m.signature,
    status: m.status,
    lastError: m.last_error,
    lastSync: m.last_sync,
    imap: { host: m.imap_host, port: m.imap_port, secure: !!m.imap_secure },
    smtp: { host: m.smtp_host, port: m.smtp_port, secure: !!m.smtp_secure },
    loginUser: m.login_user,
  };
}

export function setMailboxStatus(id, status, error = null) {
  db.prepare('UPDATE mailboxes SET status = ?, last_error = ?, last_sync = CASE WHEN ? = \'ok\' THEN ? ELSE last_sync END WHERE id = ?').run(
    status,
    error,
    status,
    now(),
    id
  );
}

// ---------- 文件夹 ----------
export const listFolders = (mailboxId) => db.prepare('SELECT * FROM folders WHERE mailbox_id = ?').all(mailboxId);
export const getFolder = (mailboxId, path) => db.prepare('SELECT * FROM folders WHERE mailbox_id = ? AND path = ?').get(mailboxId, path);
export const specialFolder = (mailboxId, use) =>
  db.prepare('SELECT * FROM folders WHERE mailbox_id = ? AND special_use = ?').get(mailboxId, use);

export const replaceFolders = tx((mailboxId, folders) => {
  const keep = new Set(folders.map((f) => f.path));
  for (const f of listFolders(mailboxId)) {
    if (!keep.has(f.path)) {
      db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, f.path);
      db.prepare('DELETE FROM folders WHERE mailbox_id = ? AND path = ?').run(mailboxId, f.path);
    }
  }
  const up = db.prepare(`INSERT INTO folders (mailbox_id, path, name, delimiter, special_use) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter, special_use = excluded.special_use`);
  for (const f of folders) up.run(mailboxId, f.path, f.name, f.delimiter, f.specialUse);
});

export function updateFolderState(mailboxId, path, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.prepare(`UPDATE folders SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE mailbox_id = @mailbox_id AND path = @path`).run({
    ...patch,
    mailbox_id: mailboxId,
    path,
  });
}

// ---------- 邮件 ----------
export const upsertMessages = tx((mailboxId, folder, items) => {
  const st = db.prepare(`INSERT INTO messages
    (mailbox_id, folder, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, sort_ts, seen, flagged, answered, has_att, size, snippet, category, signals)
    VALUES (@mailbox_id, @folder, @uid, @message_id, @thread_id, @subject, @from_name, @from_addr, @to_json, @cc_json, @date, @date, @seen, @flagged, @answered, @has_att, @size, @snippet, @category, @signals)
    ON CONFLICT(mailbox_id, folder, uid) DO NOTHING`);
  const upd = db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  const inserted = [];
  for (const m of items) {
    const info = st.run({
      mailbox_id: mailboxId,
      folder,
      uid: m.uid,
      message_id: m.messageId || null,
      thread_id: m.threadId || null,
      subject: m.subject,
      from_name: m.from?.name || '',
      from_addr: (m.from?.address || '').toLowerCase(),
      to_json: JSON.stringify(m.to || []),
      cc_json: JSON.stringify(m.cc || []),
      date: m.date,
      seen: m.seen ? 1 : 0,
      flagged: m.flagged ? 1 : 0,
      answered: m.answered ? 1 : 0,
      has_att: m.hasAttachments ? 1 : 0,
      size: m.size || 0,
      snippet: m.snippet || '',
      category: m.category || 'people',
      signals: signalsOf(m.subject, m.snippet).join(','),
    });
    if (info.changes) inserted.push({ id: Number(info.lastInsertRowid), ...m });
    else upd.run(m.seen ? 1 : 0, m.flagged ? 1 : 0, m.answered ? 1 : 0, mailboxId, folder, m.uid);
  }
  return inserted;
});

export const cachedUids = (mailboxId, folder) =>
  db.prepare('SELECT uid, seen, flagged, answered FROM messages WHERE mailbox_id = ? AND folder = ?').all(mailboxId, folder);

export const maxUid = (mailboxId, folder) =>
  db.prepare('SELECT MAX(uid) u FROM messages WHERE mailbox_id = ? AND folder = ?').get(mailboxId, folder).u || 0;
export const minUid = (mailboxId, folder) =>
  db.prepare('SELECT MIN(uid) u FROM messages WHERE mailbox_id = ? AND folder = ?').get(mailboxId, folder).u || 0;
export const countCached = (mailboxId, folder) =>
  db.prepare('SELECT COUNT(*) n FROM messages WHERE mailbox_id = ? AND folder = ?').get(mailboxId, folder).n;

export const applyFlagChanges = tx((mailboxId, folder, changes) => {
  const st = db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  for (const c of changes) st.run(c.seen ? 1 : 0, c.flagged ? 1 : 0, c.answered ? 1 : 0, mailboxId, folder, c.uid);
});

export const deleteUids = tx((mailboxId, folder, uids) => {
  const st = db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  for (const u of uids) st.run(mailboxId, folder, u);
});

export const clearFolderMessages = (mailboxId, folder) =>
  db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, folder);

export function getMessagesForUser(userId, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT m.* FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.id IN (${ph})`)
    .all(userId, ...ids);
}

export function patchMessages(ids, patch) {
  if (!ids.length) return;
  const cols = Object.keys(patch);
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE messages SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id IN (${ph})`).run(...cols.map((c) => patch[c]), ...ids);
}

export function deleteMessageRows(ids) {
  if (!ids.length) return;
  db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

export function rowToMessage(r) {
  return {
    id: r.id,
    mailboxId: r.mailbox_id,
    folder: r.folder,
    uid: r.uid,
    messageId: r.message_id,
    threadId: r.thread_id,
    subject: r.subject,
    from: { name: r.from_name, address: r.from_addr },
    to: JSON.parse(r.to_json || '[]'),
    cc: JSON.parse(r.cc_json || '[]'),
    date: r.date,
    sortTs: r.sort_ts,
    seen: !!r.seen,
    flagged: !!r.flagged,
    answered: !!r.answered,
    hasAttachments: !!r.has_att,
    snippet: r.snippet,
    category: r.category,
    pinned: !!r.pinned,
    snoozeUntil: r.snooze_until,
    skipInbox: !!r.skip_inbox,
    threadCount: r.thread_count || 1,
    specialUse: r.special_use,
    signals: r.signals ? r.signals.split(',') : [],
    doneAt: r.done_at || null,
    nudgeOff: !!r.nudge_off,
    aiNote: r.ai_note ? JSON.parse(r.ai_note) : null,
  };
}

/** 旧数据补算业务意图 */
export function backfillSignals() {
  const rows = db.prepare('SELECT id, subject, snippet FROM messages WHERE signals IS NULL LIMIT 20000').all();
  if (!rows.length) return;
  const st = db.prepare('UPDATE messages SET signals = ? WHERE id = ?');
  tx(() => rows.forEach((r) => st.run(signalsOf(r.subject, r.snippet).join(','), r.id)))();
}

/** 解析搜索语法：from/to/subject/has/is + label:/is:vip/category:，其余为关键词 */
export function parseQuery(q) {
  const out = {
    terms: [],
    from: [],
    to: [],
    subject: [],
    labels: [],
    labelIds: [],
    categories: [],
    hasAtt: false,
    unread: false,
    starred: false,
    vip: false,
  };
  const re = /(\w+):("[^"]+"|\S+)|"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) {
      const key = m[1].toLowerCase();
      const val = m[2].replace(/^"|"$/g, '');
      if (key === 'from') out.from.push(val);
      else if (key === 'to') out.to.push(val);
      else if (key === 'subject') out.subject.push(val);
      else if (key === 'has' && /^(attachment|附件)$/i.test(val)) out.hasAtt = true;
      else if (key === 'is' && /^(unread|未读)$/i.test(val)) out.unread = true;
      else if (key === 'is' && /^(starred|flagged|星标)$/i.test(val)) out.starred = true;
      else if (key === 'is' && /^(vip|VIP)$/i.test(val)) out.vip = true;
      else if (key === 'label') {
        const idm = /^id:(\d+)$/i.exec(val);
        if (idm) out.labelIds.push(Number(idm[1]));
        else if (val) out.labels.push(val);
      }
      else if (key === 'category' || key === 'cat') {
        const c = val.toLowerCase();
        if (['people', 'notification', 'newsletter', '联系人', '通知', '订阅', '订阅资讯'].includes(c)) {
          const map = { 联系人: 'people', 通知: 'notification', 订阅: 'newsletter', 订阅资讯: 'newsletter' };
          out.categories.push(map[c] || c);
        } else out.terms.push(m[0]);
      }
      else out.terms.push(m[0]);
    } else out.terms.push(m[3] || m[4]);
  }
  return out;
}

const like = (s) => `%${String(s).replace(/[%_\\]/g, (c) => '\\' + c)}%`;

/** 同一会话中「我」最后一次发信的时间（任一已绑定邮箱，不含草稿） */
export const MY_LAST_SQL = `(SELECT MAX(s.date) FROM messages s
    JOIN mailboxes sb ON sb.id = s.mailbox_id
    LEFT JOIN folders sf ON sf.mailbox_id = s.mailbox_id AND sf.path = s.folder
    WHERE sb.user_id = b.user_id AND m.thread_id IS NOT NULL AND s.thread_id = m.thread_id AND s.from_addr = sb.email
      AND IFNULL(sf.special_use, '') NOT IN ('\\Drafts', '\\Trash'))`;

export function queryMessages(userId, { mailboxId, box = 'inbox', folder, category, q, cursor, limit = 50, excludePinned = false, onlyPinned = false, ids, map, labelId }) {
  const where = ['b.user_id = @userId'];
  const p = { userId, limit };
  if (ids) {
    if (!ids.length) return { messages: [], nextCursor: null };
    where.push(`m.id IN (${ids.map(Number).filter(Number.isInteger).join(',')})`);
    box = 'any';
    q = '';
  }
  if (mailboxId && mailboxId !== 'all') {
    where.push('m.mailbox_id = @mailboxId');
    p.mailboxId = mailboxId;
  }
  const special = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }[box];
  if (special) {
    where.push('f.special_use = @special');
    p.special = special;
  }
  if (box === 'inbox') where.push('m.snooze_until IS NULL AND IFNULL(m.skip_inbox, 0) = 0');
  if (box === 'unread') where.push("m.seen = 0 AND f.special_use = '\\Inbox' AND m.snooze_until IS NULL AND IFNULL(m.skip_inbox, 0) = 0");
  if (box === 'flagged') where.push("m.flagged = 1 AND IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk')");
  if (box === 'snoozed') where.push('m.snooze_until IS NOT NULL');
  if (box === 'folder') {
    where.push('m.folder = @folder');
    p.folder = folder;
  }
  if (box === 'label') {
    const lid = Number(labelId);
    if (!Number.isInteger(lid)) {
      return { messages: [], nextCursor: null };
    }
    where.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_pk = m.id AND ml.label_id = @labelId)');
    where.push("IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk')");
    p.labelId = lid;
  }
  if (category && category !== 'all') {
    where.push('m.category = @category');
    p.category = category;
  }
  if (excludePinned) where.push('m.pinned = 0');
  if (onlyPinned) where.push('m.pinned = 1');

  if (q) {
    const pq = parseQuery(q);
    pq.terms.forEach((t, i) => {
      where.push(`(m.subject LIKE @t${i} ESCAPE '\\' OR m.from_name LIKE @t${i} ESCAPE '\\' OR m.from_addr LIKE @t${i} ESCAPE '\\' OR m.snippet LIKE @t${i} ESCAPE '\\' OR m.to_json LIKE @t${i} ESCAPE '\\')`);
      p[`t${i}`] = like(t);
    });
    pq.from.forEach((t, i) => {
      where.push(`(m.from_name LIKE @f${i} ESCAPE '\\' OR m.from_addr LIKE @f${i} ESCAPE '\\')`);
      p[`f${i}`] = like(t);
    });
    pq.to.forEach((t, i) => {
      where.push(`(m.to_json LIKE @o${i} ESCAPE '\\' OR m.cc_json LIKE @o${i} ESCAPE '\\')`);
      p[`o${i}`] = like(t);
    });
    pq.subject.forEach((t, i) => {
      where.push(`m.subject LIKE @s${i} ESCAPE '\\'`);
      p[`s${i}`] = like(t);
    });
    if (pq.hasAtt) where.push('m.has_att = 1');
    if (pq.unread) where.push('m.seen = 0');
    if (pq.starred) where.push('m.flagged = 1');
    if (pq.vip) {
      where.push(`EXISTS (
        SELECT 1 FROM sender_rules sr
        WHERE sr.user_id = @userId AND sr.kind = 'vip'
          AND (sr.key = lower(m.from_addr) OR (sr.key LIKE '@%' AND lower(m.from_addr) LIKE '%' || sr.key))
      )`);
    }
    pq.categories.forEach((c, i) => {
      where.push(`m.category = @cat${i}`);
      p[`cat${i}`] = c;
    });
    pq.labels.forEach((name, i) => {
      where.push(`EXISTS (
        SELECT 1 FROM message_labels ml JOIN labels lb ON lb.id = ml.label_id
        WHERE ml.message_pk = m.id AND lb.user_id = @userId AND lb.name = @ln${i} COLLATE NOCASE
      )`);
      p[`ln${i}`] = name;
    });
    pq.labelIds.forEach((lid, i) => {
      where.push(`EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_pk = m.id AND ml.label_id = @lid${i})`);
      p[`lid${i}`] = lid;
    });
    if (box !== 'trash' && box !== 'junk' && box !== 'folder' && box !== 'label') where.push("IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk')");
  }

  if (cursor) {
    const [ts, id] = String(cursor).split(':').map(Number);
    where.push('(m.sort_ts < @cts OR (m.sort_ts = @cts AND m.id < @cid))');
    p.cts = ts;
    p.cid = id;
  }

  const rows = db
    .prepare(
      `SELECT m.*, f.special_use,
        (SELECT COUNT(DISTINCT IFNULL(t.message_id, t.id)) FROM messages t WHERE t.mailbox_id = m.mailbox_id AND t.thread_id = m.thread_id AND m.thread_id IS NOT NULL) AS thread_count,
        ${MY_LAST_SQL} AS my_last
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE ${where.join(' AND ')}
       ORDER BY m.sort_ts DESC, m.id DESC
       LIMIT @limit`
    )
    .all(p);
  const messages = map ? map(rows) : rows.map(rowToMessage);
  const last = rows[rows.length - 1];
  return { messages, nextCursor: rows.length === limit && last ? `${last.sort_ts}:${last.id}` : null };
}

export function threadMessages(userId, row) {
  if (!row.thread_id) return [row];
  const rows = db
    .prepare(
      `SELECT m.*, f.special_use FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ? AND m.mailbox_id = ? AND (m.thread_id = ? OR m.message_id = ?)
         AND (IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk') OR m.id = ?)
       ORDER BY m.date ASC LIMIT 100`
    )
    .all(userId, row.mailbox_id, row.thread_id, row.thread_id, row.id);
  // 同一封邮件可能同时存在于「已发送」和「收件箱」（发给自己 / 抄送自己），按 Message-ID 只保留一份
  const rank = (r) => (r.id === row.id ? 0 : r.special_use === '\\Sent' ? 2 : 1);
  const best = new Map();
  for (const r of rows) {
    const key = r.message_id || `#${r.id}`;
    const cur = best.get(key);
    if (!cur || rank(r) < rank(cur)) best.set(key, r);
  }
  const keep = new Set([...best.values()].map((r) => r.id));
  return rows.filter((r) => keep.has(r.id));
}

export function counts(userId) {
  const inbox = db
    .prepare(
      `SELECT f.mailbox_id, f.unseen FROM folders f JOIN mailboxes b ON b.id = f.mailbox_id
       WHERE b.user_id = ? AND f.special_use = '\\Inbox'`
    )
    .all(userId);
  const snoozed = db
    .prepare('SELECT COUNT(*) n FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.snooze_until IS NOT NULL')
    .get(userId).n;
  const scheduled = db
    .prepare("SELECT COUNT(*) n FROM outbox WHERE user_id = ? AND (status = 'failed' OR (status = 'scheduled' AND send_at - created_at > 65000))")
    .get(userId).n;
  return { unifiedUnread: inbox.reduce((s, r) => s + r.unseen, 0), snoozed, scheduled };
}

// ---------- 正文缓存 ----------
export const getBody = (pk) => db.prepare('SELECT * FROM bodies WHERE message_pk = ?').get(pk);
export function saveBody(pk, { html, text, meta }) {
  if ((html?.length || 0) + (text?.length || 0) > 3 * 1024 * 1024) return;
  db.prepare('INSERT OR REPLACE INTO bodies (message_pk, html, text, meta, fetched_at) VALUES (?, ?, ?, ?, ?)').run(
    pk,
    html,
    text,
    JSON.stringify(meta),
    now()
  );
}
export function pruneBodies(keep = 3000) {
  db.prepare('DELETE FROM bodies WHERE message_pk NOT IN (SELECT message_pk FROM bodies ORDER BY fetched_at DESC LIMIT ?)').run(keep);
}

// ---------- 联系人 ----------
const upContact = db.prepare(`INSERT INTO contacts (user_id, address, name, score, last_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, address) DO UPDATE SET score = score + excluded.score, last_at = excluded.last_at,
  name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`);
export const addContacts = tx((userId, list, weight = 1) => {
  for (const c of list) {
    const address = String(c?.address || '').trim().toLowerCase();
    if (!address || !/@/.test(address) || /no[-_.]?reply|mailer-daemon/i.test(address)) continue;
    upContact.run(userId, address, String(c.name || '').replace(/^"|"$/g, '').trim(), weight, now());
  }
});
export const searchContacts = (userId, q) =>
  db
    .prepare(
      `SELECT address, name FROM contacts WHERE user_id = ? AND (address LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
       ORDER BY score DESC, last_at DESC LIMIT 8`
    )
    .all(userId, like(q), like(q));
export const isKnownContact = (userId, address) =>
  !!db.prepare('SELECT 1 FROM contacts WHERE user_id = ? AND address = ? AND score >= 2').get(userId, String(address || '').toLowerCase());

// ---------- 模板 ----------
export const listTemplates = (userId) => db.prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY name').all(userId);
export function saveTemplate(userId, { id, name, subject, body }) {
  if (!String(name || '').trim()) throw new Error('请填写模板名称');
  if (id) {
    db.prepare('UPDATE templates SET name = ?, subject = ?, body = ? WHERE id = ? AND user_id = ?').run(name, subject || '', body || '', id, userId);
    return id;
  }
  return Number(db.prepare('INSERT INTO templates (user_id, name, subject, body, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, name, subject || '', body || '', now()).lastInsertRowid);
}
export const deleteTemplate = (userId, id) => db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(id, userId);

// ---------- 定时发送 ----------
export function addOutbox(userId, mailboxId, payload, filesDir, sendAt) {
  return Number(
    db
      .prepare('INSERT INTO outbox (user_id, mailbox_id, payload, files_dir, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, mailboxId, JSON.stringify(payload), filesDir, sendAt, now()).lastInsertRowid
  );
}
export const listOutbox = (userId) =>
  db.prepare("SELECT * FROM outbox WHERE user_id = ? AND status IN ('scheduled', 'failed', 'sending') ORDER BY send_at").all(userId);
export const getOutbox = (userId, id) => db.prepare('SELECT * FROM outbox WHERE id = ? AND user_id = ?').get(id, userId);
export const dueOutbox = () => db.prepare("SELECT * FROM outbox WHERE status = 'scheduled' AND send_at <= ? LIMIT 20").all(now());
export const setOutboxStatus = (id, status, error = null) => db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?').run(status, error, id);
export const updateOutboxTime = (id, sendAt) => db.prepare("UPDATE outbox SET send_at = ?, status = 'scheduled', error = NULL WHERE id = ?").run(sendAt, id);
export const deleteOutbox = (id) => db.prepare('DELETE FROM outbox WHERE id = ?').run(id);

// ---------- 稍后处理 ----------
export const dueSnoozes = () =>
  db
    .prepare('SELECT m.*, b.user_id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.snooze_until IS NOT NULL AND m.snooze_until <= ?')
    .all(now());

// ---------- AI 翻译缓存 ----------
export function getTranslateCache(messagePk, target, gHash) {
  return db
    .prepare(
      'SELECT subject, body, source_lang AS sourceLang, created_at AS createdAt FROM ai_translate_cache WHERE message_pk = ? AND target = ? AND glossary_hash = ?'
    )
    .get(messagePk, target, gHash);
}

export function setTranslateCache(messagePk, target, gHash, { subject, body, sourceLang }) {
  db.prepare(
    `INSERT INTO ai_translate_cache (message_pk, target, glossary_hash, subject, body, source_lang, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_pk, target, glossary_hash) DO UPDATE SET
       subject = excluded.subject, body = excluded.body, source_lang = excluded.source_lang, created_at = excluded.created_at`
  ).run(messagePk, target, gHash, subject || '', body || '', sourceLang || '', now());
}

export function errorMailboxCount() {
  return db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE status = 'error'").get().n;
}
