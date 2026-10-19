import { db, now, tx } from './db.js';
import { signalsOf } from './classify.js';
import * as contactsCrm from './contacts.js';

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
    brandId: m.brand_id || null,
    provider: m.provider,
    providerName: m.provider_name,
    signature: m.signature,
    status: m.status,
    lastError: m.last_error,
    lastSync: m.last_sync,
    imap: { host: m.imap_host, port: m.imap_port, secure: !!m.imap_secure },
    smtp: { host: m.smtp_host, port: m.smtp_port, secure: !!m.smtp_secure },
    loginUser: m.login_user,
    authType: m.oauth_refresh_enc || m.oauth_access_enc ? 'oauth' : 'password',
    oauthProvider: m.oauth_provider || null,
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

export const replaceFolders = (mailboxId, folders) => {
  const keep = new Set(folders.map((f) => f.path));
  const idsOf = db.prepare('SELECT id FROM messages WHERE mailbox_id = ? AND folder = ?');
  const gone = [];
  const run = tx(() => {
    for (const f of listFolders(mailboxId)) {
      if (!keep.has(f.path)) {
        for (const r of idsOf.all(mailboxId, f.path)) gone.push(r.id);
        db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, f.path);
        db.prepare('DELETE FROM folders WHERE mailbox_id = ? AND path = ?').run(mailboxId, f.path);
      }
    }
    const up = db.prepare(`INSERT INTO folders (mailbox_id, path, name, delimiter, special_use) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter, special_use = excluded.special_use`);
    for (const f of folders) up.run(mailboxId, f.path, f.name, f.delimiter, f.specialUse);
  });
  run();
  if (gone.length) removeFts(gone);
};

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
  const mb = getMailboxById(mailboxId);
  const userId = mb?.user_id;
  const st = db.prepare(`INSERT INTO messages
    (mailbox_id, folder, uid, message_id, thread_id, in_reply_to, subject, from_name, from_addr, to_json, cc_json, date, sort_ts, seen, flagged, answered, has_att, size, snippet, category, signals)
    VALUES (@mailbox_id, @folder, @uid, @message_id, @thread_id, @in_reply_to, @subject, @from_name, @from_addr, @to_json, @cc_json, @date, @date, @seen, @flagged, @answered, @has_att, @size, @snippet, @category, @signals)
    ON CONFLICT(mailbox_id, folder, uid) DO NOTHING`);
  const upd = db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  const inserted = [];
  for (const m of items) {
    const preview = m.preview || m.snippet || '';
    const threadId = userId
      ? resolveThreadId(userId, {
          messageId: m.messageId,
          inReplyTo: m.inReplyTo,
          threadId: m.threadId,
          references: m.references,
        })
      : m.threadId || m.messageId || null;
    const info = st.run({
      mailbox_id: mailboxId,
      folder,
      uid: m.uid,
      message_id: m.messageId || null,
      thread_id: threadId,
      in_reply_to: m.inReplyTo || null,
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
      // 入库即用正文预览算意图（不再只靠 200 字 snippet）
      signals: signalsOf(m.subject, preview).join(','),
    });
    if (info.changes) {
      const id = Number(info.lastInsertRowid);
      inserted.push({ id, ...m, threadId });
      try {
        upsertFts(id, {
          subject: m.subject,
          snippet: m.snippet,
          fromName: m.from?.name,
          fromAddr: m.from?.address,
          body: preview,
        });
      } catch {
        /* fts optional */
      }
    } else {
      upd.run(m.seen ? 1 : 0, m.flagged ? 1 : 0, m.answered ? 1 : 0, mailboxId, folder, m.uid);
      // 父信晚到时回填会话键（原 ON CONFLICT DO NOTHING 会永久断链）
      if (threadId) {
        const row = db
          .prepare('SELECT id, thread_id, message_id FROM messages WHERE mailbox_id = ? AND folder = ? AND uid = ?')
          .get(mailboxId, folder, m.uid);
        if (row && row.thread_id !== threadId) {
          const weak = !row.thread_id || row.thread_id === row.message_id;
          if (weak) db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(threadId, row.id);
        }
      }
    }
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

export const deleteUids = (mailboxId, folder, uids) => {
  const getId = db.prepare('SELECT id FROM messages WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  const delMsg = db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ? AND uid = ?');
  const ftsIds = [];
  const run = tx(() => {
    for (const u of uids) {
      const row = getId.get(mailboxId, folder, u);
      if (row) ftsIds.push(row.id);
      delMsg.run(mailboxId, folder, u);
    }
  });
  run();
  if (ftsIds.length) removeFts(ftsIds);
};

export const clearFolderMessages = (mailboxId, folder) => {
  const ids = db.prepare('SELECT id FROM messages WHERE mailbox_id = ? AND folder = ?').all(mailboxId, folder).map((r) => r.id);
  const result = db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder = ?').run(mailboxId, folder);
  removeFts(ids);
  return result;
};

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
  // 先删主表，再清 FTS：索引损坏时也不能挡住「删除邮件」
  db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  removeFts(ids);
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

/** 用主题 + 正文/摘要重算意图；有正文时覆盖仅摘要的弱信号 */
export function refreshSignals(messagePk, subject, text = '') {
  const blob = String(text || '').slice(0, 8000);
  const sig = signalsOf(subject, blob).join(',');
  const row = db.prepare('SELECT signals FROM messages WHERE id = ?').get(messagePk);
  if (!row) return [];
  if (row.signals === sig) return sig ? sig.split(',') : [];
  db.prepare('UPDATE messages SET signals = ? WHERE id = ?').run(sig, messagePk);
  return sig ? sig.split(',') : [];
}

/** 旧数据补算业务意图（优先用已缓存正文） */
export function backfillSignals() {
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.snippet, b.text AS body_text
       FROM messages m
       LEFT JOIN bodies b ON b.message_pk = m.id
       WHERE m.signals IS NULL
       LIMIT 20000`
    )
    .all();
  if (!rows.length) return;
  const st = db.prepare('UPDATE messages SET signals = ? WHERE id = ?');
  tx(() =>
    rows.forEach((r) => {
      const text = (r.body_text || r.snippet || '').slice(0, 8000);
      st.run(signalsOf(r.subject, text).join(','), r.id);
    })
  )();
}

/**
 * FTS5 MATCH 片段。unicode61 对 CJK 按字切词：整词加引号常 0 命中。
 * CJK → NEAR/1；款号/英文 → 分段 + 前缀。
 */
export function ftsEscape(term) {
  const raw = String(term || '')
    .replace(/["*]/g, ' ')
    .trim();
  if (!raw) return '';
  const chars = [...raw];
  const cjk = chars.filter((ch) => /[\u3400-\u9fff]/.test(ch));
  const nonSpace = chars.filter((ch) => !/\s/.test(ch));
  // 纯中日韩（可夹空白）
  if (cjk.length && cjk.length === nonSpace.length) {
    if (cjk.length === 1) return cjk[0];
    return cjk.join(' NEAR/1 ');
  }
  // 中英混排：CJK 邻近 + 拉丁分段
  if (cjk.length >= 2) {
    const latin = raw
      .replace(/[\u3400-\u9fff]/g, ' ')
      .split(/[^0-9a-zA-Z]+/i)
      .filter(Boolean);
    const bits = [cjk.join(' NEAR/1 ')];
    for (const t of latin) bits.push(t.length >= 2 ? `"${t}"*` : `"${t}"`);
    return bits.join(' ');
  }
  const parts = raw.split(/[^0-9a-zA-Z]+/i).filter(Boolean);
  if (!parts.length) return '';
  return parts.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(' ');
}

/** SQLite / FTS 损坏或 contentless 误建（删信、丢弃草稿常踩中） */
export function isSqliteCorrupt(e) {
  const m = String(e?.message || e || '');
  return /malformed|corrupt|SQLITE_CORRUPT|disk image|contentless|no column named from_name|no column named to_json/i.test(m);
}

const FTS_DDL = `CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  snippet,
  from_text,
  body,
  tokenize='unicode61 remove_diacritics 2'
)`;

let ftsRebuildBusy = false;

/** 旧版 external-content 触发器（列 from_name/to_json）与现行 FTS 冲突，必须卸掉 */
export function dropLegacyFtsTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
  `);
}

/** 丢弃损坏/contentless 的 FTS 索引并全量重建（邮件主表不动） */
export function rebuildFtsIndex() {
  if (ftsRebuildBusy) return;
  ftsRebuildBusy = true;
  try {
    console.warn('[fts] rebuilding messages_fts…');
    dropLegacyFtsTriggers();
    db.exec('DROP TABLE IF EXISTS messages_fts');
    db.exec(FTS_DDL);
    backfillFts(100000);
    console.warn('[fts] rebuild done');
  } finally {
    ftsRebuildBusy = false;
  }
}

function ftsWrite(fn) {
  try {
    return fn();
  } catch (e) {
    if (!isSqliteCorrupt(e)) throw e;
    rebuildFtsIndex();
    return fn();
  }
}

export function upsertFts(messagePk, { subject = '', snippet = '', fromName = '', fromAddr = '', body = '' } = {}) {
  const fromText = `${fromName} ${fromAddr}`.trim();
  const row = [messagePk, subject || '', snippet || '', fromText, String(body || '').slice(0, 50000)];
  ftsWrite(() => {
    db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(messagePk);
    db.prepare(
      `INSERT INTO messages_fts (rowid, subject, snippet, from_text, body) VALUES (?, ?, ?, ?, ?)`
    ).run(...row);
  });
}

/** 尽力清 FTS；损坏时自愈，绝不阻断删信主路径 */
export function removeFts(messagePks = []) {
  const ids = messagePks.map(Number).filter((n) => Number.isInteger(n));
  if (!ids.length) return;
  try {
    ftsWrite(() => {
      const st = db.prepare('DELETE FROM messages_fts WHERE rowid = ?');
      tx(() => ids.forEach((id) => st.run(id)))();
    });
  } catch (e) {
    console.warn('[fts] removeFts skipped after rebuild:', e.message);
  }
}

/** 启动探针：卸旧触发器 + contentless/损坏自愈，避免删信与同步失败 */
export function ensureFtsHealthy() {
  dropLegacyFtsTriggers();
  try {
    const row = db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').get();
    if (!row) {
      db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(-1);
      return;
    }
    const snap = db.prepare('SELECT * FROM messages_fts WHERE rowid = ?').get(row.id);
    db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(row.id);
    if (snap) {
      db.prepare(
        `INSERT INTO messages_fts (rowid, subject, snippet, from_text, body) VALUES (?, ?, ?, ?, ?)`
      ).run(row.id, snap.subject || '', snap.snippet || '', snap.from_text || '', snap.body || '');
    }
  } catch (e) {
    if (!isSqliteCorrupt(e) && !/no column named from_name|no column named to_json/i.test(e.message || '')) {
      console.warn('[fts] probe:', e.message);
      return;
    }
    try {
      rebuildFtsIndex();
    } catch (e2) {
      console.error('[fts] rebuild failed:', e2.message);
    }
  }
}

/** 全文检索命中的 message id（最多 limit）；FTS 不可用时返回 null 以回退 LIKE */
export function searchFtsIds(terms = [], limit = 500) {
  const q = terms.map(ftsEscape).filter(Boolean).join(' ');
  if (!q) return null;
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get().n;
    if (!n) return null; // 尚未建索引 → LIKE
    return db
      .prepare(
        `SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?
         ORDER BY bm25(messages_fts) LIMIT ?`
      )
      .all(q, limit)
      .map((r) => r.id);
  } catch {
    // 旧 MATCH 语法失败时回退无排序
    try {
      return db
        .prepare(`SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?`)
        .all(q, limit)
        .map((r) => r.id);
    } catch {
      return null;
    }
  }
}

/** 启动时差量补齐 FTS，并清理孤儿索引（删信路径漏清时自愈） */
export function backfillFts(limit = 15000) {
  try {
    db.prepare('DELETE FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)').run();
  } catch (e) {
    if (isSqliteCorrupt(e)) {
      // 由 ensureFtsHealthy / rebuild 处理，避免递归
      throw e;
    }
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.snippet, m.from_name, m.from_addr, b.text AS body
       FROM messages m
       LEFT JOIN bodies b ON b.message_pk = m.id
       WHERE m.id NOT IN (SELECT rowid FROM messages_fts)
       ORDER BY m.date DESC LIMIT ?`
    )
    .all(limit);
  if (!rows.length) return;
  const ins = db.prepare(
    `INSERT INTO messages_fts (rowid, subject, snippet, from_text, body) VALUES (?, ?, ?, ?, ?)`
  );
  const run = tx(() => {
    for (const r of rows) {
      const fromText = `${r.from_name || ''} ${r.from_addr || ''}`.trim();
      try {
        db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(r.id);
      } catch {
        /* ignore */
      }
      ins.run(r.id, r.subject || '', r.snippet || '', fromText, String(r.body || '').slice(0, 50000));
    }
  });
  run();
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

/**
 * 同一会话中「我」最后一次发信（含 In-Reply-To 断链补全，不含草稿/已删除）
 */
export const MY_LAST_SQL = `(SELECT MAX(s.date) FROM messages s
    JOIN mailboxes sb ON sb.id = s.mailbox_id
    LEFT JOIN folders sf ON sf.mailbox_id = s.mailbox_id AND sf.path = s.folder
    WHERE sb.user_id = b.user_id AND s.from_addr = sb.email
      AND IFNULL(sf.special_use, '') NOT IN ('\\Drafts', '\\Trash')
      AND (
        (m.thread_id IS NOT NULL AND s.thread_id = m.thread_id)
        OR (m.message_id IS NOT NULL AND s.in_reply_to = m.message_id)
        OR (m.in_reply_to IS NOT NULL AND (s.message_id = m.in_reply_to OR s.in_reply_to = m.in_reply_to OR s.thread_id = m.in_reply_to))
      ))`;

/** 对方在同一会话的最后来信（线程键 + In-Reply-To） */
export const THEIR_LAST_SQL = `(SELECT MAX(t.date) FROM messages t JOIN mailboxes tb ON tb.id = t.mailbox_id
    WHERE tb.user_id = b.user_id
      AND t.from_addr NOT IN (SELECT email FROM mailboxes WHERE user_id = b.user_id)
      AND (
        (m.thread_id IS NOT NULL AND t.thread_id = m.thread_id)
        OR (m.message_id IS NOT NULL AND t.in_reply_to = m.message_id)
        OR (m.in_reply_to IS NOT NULL AND (t.message_id = m.in_reply_to OR t.in_reply_to = m.in_reply_to))
      ))`;

/** Message-Id 常见带/不带尖括号，匹配时两边都试 */
function idVariants(...ids) {
  const out = new Set();
  for (const raw of ids) {
    const s = String(raw || '').trim();
    if (!s) continue;
    out.add(s);
    const bare = s.replace(/^<|>$/g, '');
    if (bare) {
      out.add(bare);
      out.add(`<${bare}>`);
    }
  }
  return [...out];
}

/** Focus / 会话去重共用键 */
export function conversationKey(row) {
  if (!row) return '';
  return row.thread_id || row.in_reply_to || row.message_id || (row.id != null ? `#${row.id}` : '');
}

/** 解析会话键：In-Reply-To → References（近到远）→ 信封 threadId */
export function resolveThreadId(userId, { messageId, inReplyTo, threadId, references } = {}) {
  const refList = Array.isArray(references)
    ? references
    : String(references || '')
        .match(/<[^>]+>/g)
        ?.map((x) => x.replace(/^<|>$/g, '')) || [];
  // 最近父信优先，再扫整条 References（含根）
  const candidates = [];
  if (inReplyTo) candidates.push(inReplyTo);
  for (let i = refList.length - 1; i >= 0; i--) candidates.push(refList[i]);
  if (refList[0]) candidates.push(refList[0]);

  const seen = new Set();
  for (const cand of candidates) {
    const variants = idVariants(cand);
    if (!variants.length) continue;
    const sig = variants.join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const ph = variants.map(() => '?').join(',');
    const parent = db
      .prepare(
        `SELECT m.thread_id, m.message_id FROM messages m
         JOIN mailboxes b ON b.id = m.mailbox_id
         WHERE b.user_id = ? AND m.message_id IN (${ph})
         ORDER BY m.date ASC LIMIT 1`
      )
      .get(userId, ...variants);
    if (parent?.thread_id) return parent.thread_id;
    if (parent?.message_id) return parent.message_id;
  }
  return threadId || messageId || idVariants(inReplyTo)[0] || null;
}

/** 发出回复后：把同会话收件箱标为已回复 */
export function markThreadAnswered(userId, { threadId, inReplyTo, messageId, references } = {}) {
  const resolved =
    threadId ||
    resolveThreadId(userId, { messageId, inReplyTo, threadId, references });
  const refArr = Array.isArray(references) ? references : [];
  const tids = idVariants(resolved, threadId, inReplyTo, messageId, ...refArr);
  if (!tids.length) return 0;
  const ph = tids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.id FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ? AND f.special_use = '\\Inbox' AND IFNULL(m.answered, 0) = 0
         AND (
           m.thread_id IN (${ph})
           OR m.message_id IN (${ph})
           OR m.in_reply_to IN (${ph})
         )`
    )
    .all(userId, ...tids, ...tids, ...tids);
  if (!rows.length) return 0;
  patchMessages(
    rows.map((r) => r.id),
    { answered: 1 }
  );
  return rows.length;
}

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
    const ftsIds = pq.terms.length ? searchFtsIds(pq.terms, 800) : null;
    if (pq.terms.length && Array.isArray(ftsIds)) {
      if (!ftsIds.length) return { messages: [], nextCursor: null };
      const ph = ftsIds.map((_, i) => `@fts${i}`).join(',');
      where.push(`m.id IN (${ph})`);
      ftsIds.forEach((id, i) => {
        p[`fts${i}`] = id;
      });
    } else {
      pq.terms.forEach((t, i) => {
        where.push(
          `(m.subject LIKE @t${i} ESCAPE '\\' OR m.from_name LIKE @t${i} ESCAPE '\\' OR m.from_addr LIKE @t${i} ESCAPE '\\' OR m.snippet LIKE @t${i} ESCAPE '\\' OR m.to_json LIKE @t${i} ESCAPE '\\' OR EXISTS (SELECT 1 FROM bodies b WHERE b.message_pk = m.id AND b.text LIKE @t${i} ESCAPE '\\'))`
        );
        p[`t${i}`] = like(t);
      });
    }
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
        (SELECT COUNT(DISTINCT IFNULL(t.message_id, t.id))
           FROM messages t
           JOIN mailboxes tb ON tb.id = t.mailbox_id
          WHERE tb.user_id = b.user_id
            AND m.thread_id IS NOT NULL
            AND t.thread_id = m.thread_id) AS thread_count,
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
  const variants = idVariants(row.thread_id, row.message_id, row.in_reply_to);
  if (!variants.length) return [row];
  const ph = variants.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.*, f.special_use FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ?
         AND (m.thread_id IN (${ph}) OR m.message_id IN (${ph}) OR m.in_reply_to IN (${ph}))
         AND (IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk') OR m.id = ?)
       ORDER BY m.date ASC LIMIT 120`
    )
    .all(userId, ...variants, ...variants, ...variants, row.id);
  // 跨邮箱合并：同 Message-ID 只留一份（优先当前打开、其次收件箱、再次已发送）
  const rank = (r) => (r.id === row.id ? 0 : r.special_use === '\\Inbox' ? 1 : r.special_use === '\\Sent' ? 2 : 3);
  const best = new Map();
  for (const r of rows) {
    const mk = r.message_id || `#${r.id}`;
    const cur = best.get(mk);
    if (!cur || rank(r) < rank(cur)) best.set(mk, r);
  }
  return [...best.values()].sort((a, b) => a.date - b.date || a.id - b.id);
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
  const outboxFailed = db
    .prepare("SELECT COUNT(*) n FROM outbox WHERE user_id = ? AND status = 'failed'")
    .get(userId).n;
  const scheduled = db
    .prepare(
      "SELECT COUNT(*) n FROM outbox WHERE user_id = ? AND ((status = 'scheduled' AND send_at - created_at > 65000) OR status = 'sending')"
    )
    .get(userId).n;
  return {
    unifiedUnread: inbox.reduce((s, r) => s + r.unseen, 0),
    snoozed,
    scheduled: scheduled + outboxFailed,
    outboxFailed,
  };
}

// ---------- 正文缓存 ----------
export const getBody = (pk) => db.prepare('SELECT * FROM bodies WHERE message_pk = ?').get(pk);
const BODY_MAX = 3 * 1024 * 1024;

/** 超限时剥 data:/style 并硬截断，保证一定能落盘（避免大信每次开信重拉 IMAP） */
function fitBodyForCache(html, text) {
  let h = html == null ? null : String(html);
  let t = text == null ? '' : String(text);
  const size = () => (h?.length || 0) + (t?.length || 0);
  if (size() <= BODY_MAX) return { html: h, text: t, trimmed: false };
  if (h) {
    h = h.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '');
    if (size() > BODY_MAX) h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  }
  if (size() > BODY_MAX && t.length > 100_000) t = `${t.slice(0, 100_000)}\n…`;
  if (size() > BODY_MAX) {
    const textBudget = Math.min(t.length, 40_000);
    t = t.slice(0, textBudget);
    const htmlBudget = Math.max(0, BODY_MAX - t.length - 24);
    if (h && h.length > htmlBudget) h = `${h.slice(0, htmlBudget)}<!-- zm-trim -->`;
  }
  while (size() > BODY_MAX) {
    if (h && h.length > 2048) h = h.slice(0, Math.floor(h.length * 0.75));
    else if (t.length > 2048) t = t.slice(0, Math.floor(t.length * 0.75));
    else {
      t = t.slice(0, Math.max(0, BODY_MAX - 1));
      h = '';
      break;
    }
  }
  return { html: h, text: t, trimmed: true };
}

export function saveBody(pk, { html, text, meta }) {
  const fitted = fitBodyForCache(html, text);
  const metaOut = { ...(meta || {}), bodyTrimmed: !!fitted.trimmed };
  db.prepare('INSERT OR REPLACE INTO bodies (message_pk, html, text, meta, fetched_at) VALUES (?, ?, ?, ?, ?)').run(
    pk,
    fitted.html,
    fitted.text,
    JSON.stringify(metaOut),
    now()
  );
  const row = db.prepare('SELECT subject, snippet, from_name, from_addr FROM messages WHERE id = ?').get(pk);
  if (row) {
    refreshSignals(pk, row.subject, fitted.text || row.snippet || '');
    try {
      upsertFts(pk, {
        subject: row.subject,
        snippet: row.snippet,
        fromName: row.from_name,
        fromAddr: row.from_addr,
        body: fitted.text || '',
      });
    } catch {
      /* ignore */
    }
  }
  return true;
}
export function pruneBodies(keep = 3000) {
  db.prepare('DELETE FROM bodies WHERE message_pk NOT IN (SELECT message_pk FROM bodies ORDER BY fetched_at DESC LIMIT ?)').run(keep);
}

// ---------- 联系人（切片 D：委托 contacts 主数据，双写兼容） ----------
export const addContacts = (userId, list, weight = 1) => contactsCrm.touchAddresses(userId, list, weight);
export const searchContacts = (userId, q) => contactsCrm.searchContactsFlat(userId, q);
export const isKnownContact = (userId, address) => contactsCrm.isKnownContact(userId, address);

// ---------- 模板（个人 + 团队共享） ----------
function publicTemplate(r, viewerId) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    subject: r.subject,
    body: r.body,
    brandId: r.brand_id || null,
    shared: !!r.shared,
    stage: r.stage || '',
    mine: r.user_id === viewerId,
    createdAt: r.created_at,
  };
}

export function listTemplates(userId, { role } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM templates
       WHERE user_id = ? OR shared = 1
       ORDER BY shared DESC, name`
    )
    .all(userId);
  return rows.map((r) => publicTemplate(r, userId));
}

export function saveTemplate(userId, { id, name, subject, body, brandId, shared, stage } = {}, { role } = {}) {
  if (!String(name || '').trim()) throw new Error('请填写模板名称');
  const share = shared ? 1 : 0;
  if (share && role !== 'admin') throw Object.assign(new Error('仅管理员可设为团队共享模板'), { status: 403 });
  const bid = brandId != null && brandId !== '' ? Number(brandId) : null;
  const st = String(stage || '').trim().slice(0, 40);
  if (id) {
    const ex = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!ex) throw Object.assign(new Error('模板不存在'), { status: 404 });
    if (ex.user_id !== userId && role !== 'admin') throw Object.assign(new Error('无权改此模板'), { status: 403 });
    db.prepare(
      `UPDATE templates SET name = ?, subject = ?, body = ?, brand_id = ?, shared = ?, stage = ? WHERE id = ?`
    ).run(name, subject || '', body || '', bid, share, st, id);
    return id;
  }
  return Number(
    db
      .prepare(
        `INSERT INTO templates (user_id, name, subject, body, created_at, brand_id, shared, stage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, name, subject || '', body || '', now(), bid, share, st).lastInsertRowid
  );
}

export function deleteTemplate(userId, id, { role } = {}) {
  const ex = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  if (!ex) return;
  if (ex.user_id !== userId && role !== 'admin') throw Object.assign(new Error('无权删除'), { status: 403 });
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

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
export const updateOutboxTime = (id, sendAt) =>
  db.prepare("UPDATE outbox SET send_at = ?, status = 'scheduled', error = NULL, tries = 0 WHERE id = ?").run(sendAt, id);
/** 瞬时失败：退避后自动再试（不重发成功件——仅 sending 失败路径调用） */
export function scheduleOutboxRetry(id, sendAt, tries, error) {
  const msg = `将自动重试（${tries}/2）：${error || '发送失败'}`;
  db.prepare("UPDATE outbox SET status = 'scheduled', send_at = ?, tries = ?, error = ? WHERE id = ?").run(sendAt, tries, msg, id);
}
export const deleteOutbox = (id) => db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
/** 仅删除仍为 scheduled 的任务（与 sending claim 互斥） */
export function deleteOutboxIfScheduled(id) {
  return db.prepare("DELETE FROM outbox WHERE id = ? AND status = 'scheduled'").run(id).changes > 0;
}
/** 取消定时/失败任务（sending 不可删，防与发送竞态） */
export function deleteOutboxIfCancellable(id) {
  return db.prepare("DELETE FROM outbox WHERE id = ? AND status IN ('scheduled', 'failed')").run(id).changes > 0;
}
/**
 * 原子抢占发送权；成功返回 claimedAt（写入 send_at 作计时锚），失败返回 null。
 * 完成/失败须带同一 claimedAt，避免超时回收后与用户重试竞态。
 */
export function claimOutboxSending(id) {
  const claimedAt = Date.now();
  const ok =
    db
      .prepare("UPDATE outbox SET status = 'sending', send_at = ? WHERE id = ? AND status = 'scheduled' AND send_at <= ?")
      .run(claimedAt, id, claimedAt + 100).changes > 0;
  return ok ? claimedAt : null;
}

/** 运行中卡住的 sending → failed（勿自动重发；提示核对已发送） */
export function reclaimStaleOutboxSending(maxAgeMs = 180_000) {
  const cutoff = Date.now() - maxAgeMs;
  const error = '发送超时中断，请到「已发送」确认是否已发出后再重试';
  const rows = db
    .prepare("SELECT id, user_id AS userId FROM outbox WHERE status = 'sending' AND send_at < ?")
    .all(cutoff);
  if (!rows.length) return [];
  db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE status = 'sending' AND send_at < ?").run(error, cutoff);
  return rows.map((r) => ({ id: r.id, userId: r.userId, error }));
}

export function finishOutboxIfClaim(id, claimedAt) {
  return (
    db.prepare("DELETE FROM outbox WHERE id = ? AND status = 'sending' AND send_at = ?").run(id, claimedAt).changes > 0
  );
}

export function failOutboxIfClaim(id, claimedAt, error) {
  return (
    db
      .prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ? AND status = 'sending' AND send_at = ?")
      .run(error || '发送失败', id, claimedAt).changes > 0
  );
}

export function scheduleOutboxRetryIfClaim(id, claimedAt, sendAt, tries, error) {
  const msg = `将自动重试（${tries}/2）：${error || '发送失败'}`;
  return (
    db
      .prepare(
        "UPDATE outbox SET status = 'scheduled', send_at = ?, tries = ?, error = ? WHERE id = ? AND status = 'sending' AND send_at = ?"
      )
      .run(sendAt, tries, msg, id, claimedAt).changes > 0
  );
}

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
  // 演示邮箱无真实 IMAP，不计入健康告警
  return db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE status = 'error' AND IFNULL(provider,'') != 'demo'").get().n;
}
