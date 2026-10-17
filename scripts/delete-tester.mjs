/**
 * 删除 tester 演示账号及其级联数据
 * 用法：node scripts/delete-tester.mjs [--dry-run]
 */
import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';

const dry = process.argv.includes('--dry-run');
const db = new Database(path.join(process.env.DATA_DIR || './data', 'mail.db'));
db.pragma('foreign_keys = ON');

const users = db
  .prepare(
    `SELECT id, email, role,
      (SELECT COUNT(*) FROM mailboxes m WHERE m.user_id = users.id) AS mailboxes,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.id) AS sessions
     FROM users
     WHERE lower(email) = 'tester' OR role = 'tester'`
  )
  .all();

console.log(JSON.stringify({ dry, targets: users }, null, 2));

if (!users.length) {
  console.log('没有 tester 账号');
  db.close();
  process.exit(0);
}

if (dry) {
  db.close();
  process.exit(0);
}

const del = db.prepare('DELETE FROM users WHERE id = ?');
const tx = db.transaction(() => {
  for (const u of users) {
    if (u.role === 'admin') throw new Error('拒绝删除 admin：' + u.email);
    del.run(u.id);
  }
});
tx();

console.log(
  JSON.stringify(
    {
      remaining: db
        .prepare('SELECT id, email, role FROM users ORDER BY id')
        .all(),
    },
    null,
    2
  )
);
db.close();
