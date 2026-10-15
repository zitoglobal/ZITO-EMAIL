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
  ['reminded', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!msgCols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_tid ON messages(thread_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(date DESC)');

export const now = () => Date.now();

export function tx(fn) {
  return db.transaction(fn);
}
