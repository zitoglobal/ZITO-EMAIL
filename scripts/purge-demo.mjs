/**
 * 清除演示邮箱及其本地邮件（provider=demo / *.zito.test / demo-*）
 * 用法：node scripts/purge-demo.mjs [--dry-run]
 * 生产：在 /opt/zito-mail 下执行（需先停 sync 噪声；本脚本只改 SQLite）
 */
import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';

const dry = process.argv.includes('--dry-run');
const dataDir = process.env.DATA_DIR || './data';
const dbPath = path.join(dataDir, 'mail.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

const all = db.prepare('SELECT id, user_id, email, provider, status FROM mailboxes').all();
const targets = all.filter((m) => {
  const email = String(m.email || '').toLowerCase();
  const provider = String(m.provider || '').toLowerCase();
  return (
    provider === 'demo' ||
    email.endsWith('@zito.test') ||
    email.startsWith('demo-') ||
    email.includes('zito.test')
  );
});

const before = {
  mailboxes: all.length,
  messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  fts: db.prepare('SELECT COUNT(*) n FROM messages_fts').get().n,
  deals: db.prepare('SELECT COUNT(*) n FROM deals').get().n,
};

console.log(
  JSON.stringify(
    {
      dry,
      dbPath,
      before,
      targets: targets.map((t) => ({
        id: t.id,
        email: t.email,
        provider: t.provider,
        messages: db.prepare('SELECT COUNT(*) n FROM messages WHERE mailbox_id = ?').get(t.id).n,
      })),
    },
    null,
    2
  )
);

if (!targets.length) {
  console.log('没有演示箱，无需清理');
  db.close();
  process.exit(0);
}

if (dry) {
  console.log('dry-run：未删除');
  db.close();
  process.exit(0);
}

const ids = targets.map((t) => t.id);
const tx = db.transaction(() => {
  const delMb = db.prepare('DELETE FROM mailboxes WHERE id = ?');
  for (const id of ids) delMb.run(id);

  // FTS 孤儿（messages 随 mailbox CASCADE 删除）
  try {
    db.prepare('DELETE FROM messages_fts WHERE rowid NOT IN (SELECT id FROM messages)').run();
  } catch (e) {
    console.warn('FTS cleanup:', e.message);
  }
});

tx();

const after = {
  mailboxes: db.prepare('SELECT COUNT(*) n FROM mailboxes').get().n,
  messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
  fts: db.prepare('SELECT COUNT(*) n FROM messages_fts').get().n,
  deals: db.prepare('SELECT COUNT(*) n FROM deals').get().n,
  remaining: db.prepare('SELECT id, email, provider FROM mailboxes').all(),
};

console.log(JSON.stringify({ after, removedMailboxes: ids.length }, null, 2));
db.close();
