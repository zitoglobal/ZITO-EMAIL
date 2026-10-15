import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'mail.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0a66ff',
  provider TEXT,
  provider_name TEXT,
  login_user TEXT NOT NULL,
  pass_enc TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL,
  auto_saves_sent INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  last_error TEXT,
  last_sync INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, email)
);

CREATE TABLE IF NOT EXISTS folders (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT,
  special_use TEXT,
  uidvalidity TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  unseen INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER,
  PRIMARY KEY (mailbox_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL,
  sort_ts INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_att INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'people',
  pinned INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  UNIQUE(mailbox_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_list ON messages(mailbox_id, folder, sort_ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_sort ON messages(sort_ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(mailbox_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_snooze ON messages(snooze_until) WHERE snooze_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS bodies (
  message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  html TEXT,
  text TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  files_dir TEXT,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, send_at);

CREATE TABLE IF NOT EXISTS sender_rules (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
`);

// 增量迁移：旧库补列
const msgCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
for (const [name, def] of [
  ['signals', 'TEXT'],
  ['done_at', 'INTEGER'],
  ['nudge_off', 'INTEGER NOT NULL DEFAULT 0'],
  ['ai_note', 'TEXT'],
  ['reminded', 'INTEGER NOT NULL DEFAULT 0'],  // 提醒阶段 0→1→2→3（兼容旧的 0/1）
  ['reminded_at', 'INTEGER'],                 // 上次提醒时间，用于冷却
]) {
  if (!msgCols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_tid ON messages(thread_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(date DESC)');

// Focus / 分诊查询加速：按邮箱+日期窗口、发件人、文件夹 special_use、会话时间线
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_mb_date ON messages(mailbox_id, date DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_mb_from_date ON messages(mailbox_id, from_addr, date DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_thread_date ON messages(thread_id, date DESC) WHERE thread_id IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_folders_special ON folders(special_use, mailbox_id)');

export const now = () => Date.now();

export function tx(fn) {
  return db.transaction(fn);
}

// ---------- AI 翻译缓存（message + target + glossaryHash） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS ai_translate_cache (
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  glossary_hash TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  source_lang TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_pk, target, glossary_hash)
);
`);

// ---------- 用户标签（切片 A） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#0a66ff',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_labels_user_pos ON labels(user_id, position);

CREATE TABLE IF NOT EXISTS message_labels (
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_pk, label_id)
);
CREATE INDEX IF NOT EXISTS idx_message_labels_label ON message_labels(label_id);
`);

// ---------- 保存的搜索 / 智能文件夹（切片 B） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  icon TEXT,
  pinned INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_user_pos ON saved_searches(user_id, position);
`);

// ---------- 邮件规则（切片 C） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS mail_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  stop_processing INTEGER NOT NULL DEFAULT 0,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  last_hit_at INTEGER,
  last_hit_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_rules_user_pos ON mail_rules(user_id, enabled, position);
`);

{
  const msgCols2 = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  if (!msgCols2.has('skip_inbox')) {
    db.exec('ALTER TABLE messages ADD COLUMN skip_inbox INTEGER NOT NULL DEFAULT 0');
  }
}

// ---------- 联系人 / 客户主数据（切片 D） ----------
db.exec(`
CREATE TABLE IF NOT EXISTS contact_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  primary_address TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_persons_user ON contact_persons(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS contact_addresses (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  person_id INTEGER NOT NULL REFERENCES contact_persons(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  name TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  PRIMARY KEY (user_id, address)
);
CREATE INDEX IF NOT EXISTS idx_contact_addresses_person ON contact_addresses(person_id);

CREATE TABLE IF NOT EXISTS contact_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#0a66ff',
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS contact_tag_map (
  person_id INTEGER NOT NULL REFERENCES contact_persons(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES contact_tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_tag_map_tag ON contact_tag_map(tag_id);
`);

// 一次性：旧 contacts → Person（可重复执行，已有地址则跳过）
{
  const pending = db
    .prepare(
      `SELECT c.user_id, c.address, c.name, c.score, c.last_at
       FROM contacts c
       WHERE NOT EXISTS (
         SELECT 1 FROM contact_addresses a WHERE a.user_id = c.user_id AND a.address = c.address COLLATE NOCASE
       )`
    )
    .all();
  if (pending.length) {
    const insPerson = db.prepare(
      `INSERT INTO contact_persons (user_id, display_name, company, note, primary_address, created_at, updated_at)
       VALUES (?, ?, '', '', ?, ?, ?)`
    );
    const insAddr = db.prepare(
      `INSERT INTO contact_addresses (user_id, address, person_id, is_primary, source, name, score, last_at)
       VALUES (?, ?, ?, 1, 'auto', ?, ?, ?)`
    );
    const migrate = db.transaction((rows) => {
      for (const r of rows) {
        const addr = String(r.address || '').trim().toLowerCase();
        if (!addr) continue;
        const t = r.last_at || Date.now();
        const name = String(r.name || '').trim();
        const info = insPerson.run(r.user_id, name, addr, t, t);
        insAddr.run(r.user_id, addr, Number(info.lastInsertRowid), name, r.score || 0, t);
      }
    });
    migrate(pending);
  }
}
