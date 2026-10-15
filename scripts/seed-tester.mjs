// 为线上测试账号（role = tester）写入内置演示邮箱与外贸邮件，登录后直接看到完整功能。
// 用法：cd /opt/zito-mail && node scripts/seed-tester.mjs [账号，默认 tester]
import Database from 'better-sqlite3';
import { signalsOf } from '../server/classify.js';

const ACCOUNT = (process.argv[2] || 'tester').toLowerCase();
const DB = process.env.DATA_DIR ? process.env.DATA_DIR + '/mail.db' : '/opt/zito-mail/data/mail.db';
const db = new Database(DB);
db.pragma('foreign_keys = ON');

const user = db.prepare('SELECT id FROM users WHERE email = ?').get(ACCOUNT);
if (!user) { console.error(`找不到账号 ${ACCOUNT}`); process.exit(1); }
db.prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(user.id);

const MB = 'demo-' + ACCOUNT;
const EMAIL = 'alice.chen@zito.test';
const now = Date.now();
const H = 3600_000, D = 24 * H;

db.prepare("UPDATE mailboxes SET status = 'ok', last_error = NULL WHERE id = ?").run(MB);
db.prepare('DELETE FROM mailboxes WHERE id = ?').run(MB);
db.prepare(
  `INSERT INTO mailboxes (id, user_id, email, name, color, provider, provider_name, login_user, pass_enc,
     imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, status, last_sync, created_at)
   VALUES (?, ?, ?, ?, '#0a66ff', 'demo', '演示邮箱', ?, 'demo', 'demo', 993, 1, 'demo', 465, 1, 'ok', ?, ?)`
).run(MB, user.id, EMAIL, 'Alice Chen', EMAIL, now, now);

const folders = [
  ['INBOX', '收件箱', '\\Inbox'],
  ['Sent', '已发送', '\\Sent'],
  ['Drafts', '草稿箱', '\\Drafts'],
  ['Trash', '已删除', '\\Trash'],
];
const insFolder = db.prepare('INSERT INTO folders (mailbox_id, path, name, special_use, total, last_sync) VALUES (?, ?, ?, ?, 0, ?)');
for (const [path, name, use] of folders) insFolder.run(MB, path, name, use, now);

const ins = db.prepare(
  `INSERT INTO messages (mailbox_id, folder, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
     date, sort_ts, seen, flagged, answered, has_att, snippet, category, signals)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 'people', ?)`
);
const insBody = db.prepare('INSERT INTO bodies (message_pk, html, text, fetched_at) VALUES (?, ?, ?, ?)');
let uid = 1000;

const to = JSON.stringify([{ name: 'Alice Chen', address: EMAIL }]);
const fromMe = JSON.stringify([{ name: 'Alice Chen', address: EMAIL }]);

const threads = [
  {
    folder: 'INBOX', seen: 1, flagged: 1, hours: 30,
    from: ['Hans Weber', 'hans.weber@modehaus.de'],
    subject: 'Re: PO#4471 shipment notice - quality issue',
    snippet: 'Dear Alice, We received the goods but found color shading on about 200 pcs of the navy hoodies. Photos attached. This is not acceptable for our stores.',
    text: 'Dear Alice,\n\nWe received the goods but found color shading on about 200 pcs of the navy hoodies. Photos attached. This is not acceptable for our stores.\n\nPlease advise how you will handle this claim.\n\nRegards,\nHans Weber\nModehaus GmbH',
  },
  {
    folder: 'INBOX', seen: 0, flagged: 0, hours: 2,
    from: ['Mike Johnson', 'mike@fashionhub-usa.com'],
    subject: "Re: Quotation - Women's Denim Jacket Style #DJ-2405",
    snippet: "Hi Alice, Good news - we'd like to confirm the order for 3,000 pcs. Please send the PI ASAP so we can arrange the 30% deposit this week.",
    text: "Hi Alice,\n\nGood news - we'd like to confirm the order for 3,000 pcs (1,500 indigo / 1,500 black). Please send the PI ASAP so we can arrange the 30% deposit this week.\n\nCan you ship by Nov 30?\n\nThanks,\nMike Johnson\nSourcing Manager, FashionHub USA",
  },
  {
    folder: 'INBOX', seen: 0, flagged: 0, hours: 5,
    from: ['Sarah Bennett', 'sarah@newbrand.co.uk'],
    subject: 'Inquiry: Yoga leggings OEM - 3,000 pcs',
    snippet: 'Hi Alice, We are looking for an OEM factory for yoga leggings, 3,000 pcs first order. Could you share your price list and MOQ?',
    text: 'Hi Alice,\n\nWe are looking for an OEM factory for yoga leggings, 3,000 pcs first order. Could you share your price list and MOQ?\n\nBest,\nSarah Bennett',
  },
  {
    folder: 'INBOX', seen: 1, flagged: 0, hours: 72,
    from: ['David Kim', 'david.kim@seoulstyle.kr'],
    subject: 'Catalogue request after Canton Fair',
    snippet: 'Hi, we met at your booth at the Canton Fair. Could you send the latest catalogue and price list for the SS25 collection?',
    text: 'Hi Alice,\n\nWe met at your booth at the Canton Fair. Could you send the latest catalogue and price list for the SS25 collection?\n\nDavid Kim\nSeoul Style',
  },
  {
    folder: 'INBOX', seen: 0, flagged: 0, hours: 1,
    from: ['Ahmed Al-Rashid', 'ahmed@dubai-textiles.ae'],
    subject: 'Re: Proforma Invoice PO#5520 - deposit paid, TT copy attached',
    snippet: 'Dear Bob, Please find attached the TT copy for the 30% deposit of PO#5520. Kindly confirm receipt and start production.',
    text: 'Dear Alice,\n\nPlease find attached the TT copy for the 30% deposit of PO#5520. Kindly confirm receipt and start production.\n\nAhmed Al-Rashid\nDubai Textiles',
  },
  {
    folder: 'INBOX', seen: 1, flagged: 0, hours: 6,
    from: ['Emma Clarke', 'emma@urbanthreads.co.uk'],
    subject: 'Re: Fit sample for SS25 cargo pants',
    snippet: 'Hi Alice, The fit sample looks good overall, but the waist is 2 cm too tight. Could you revise and send a new sample?',
    text: 'Hi Alice,\n\nThe fit sample looks good overall, but the waist is 2 cm too tight. Could you revise and send a new sample?\n\nEmma Clarke\nUrban Threads',
  },
  {
    folder: 'Sent', seen: 1, flagged: 0, days: 4,
    from: ['Alice Chen', EMAIL], to: ['Carlos Mendes', 'carlos@lisboafashion.pt'],
    subject: 'Re: Quotation for knitted polo shirts - 2,000 pcs',
    snippet: 'Hi Carlos, Just following up on my email below — happy to adjust the price if we confirm before Friday.',
    text: 'Hi Carlos,\n\nJust following up on my email below — happy to adjust the price if we confirm before Friday.\n\nBest regards,\nAlice Chen',
  },
  {
    folder: 'Sent', seen: 1, flagged: 0, days: 3,
    from: ['Alice Chen', EMAIL], to: ['Yuki Tanaka', 'yuki@tokyowear.jp'],
    subject: 'Samples shipped - tracking JP8821934',
    snippet: 'Hi Yuki, The 3 samples were shipped today via DHL, tracking JP8821934. Please confirm once received.',
    text: 'Hi Yuki,\n\nThe 3 samples were shipped today via DHL, tracking JP8821934. Please confirm once received.\n\nBest regards,\nAlice Chen',
  },
];

const tx = db.transaction(() => {
  for (const t of threads) {
    const date = now - (t.days ? t.days * D : t.hours * H);
    const [name, addr] = t.from;
    const toJson = t.to ? JSON.stringify([{ name: t.to[0], address: t.to[1] }]) : to;
    const id = ins.run(
      MB, t.folder, ++uid, `<demo-${uid}@zito.test>`, `thread-${uid}`, t.subject, name, addr, toJson,
      date, date, t.seen, t.flagged, 0, 0, t.snippet, JSON.stringify(signalsOf(t.subject, t.snippet))
    ).lastInsertRowid;
    const html = t.text.split('\n').map((l) => (l ? `<p>${l}</p>` : '<br>')).join('');
    insBody.run(id, html, t.text, now);
  }
  db.prepare("INSERT OR IGNORE INTO sender_rules (user_id, key, kind, name, created_at) VALUES (?, '@fashionhub-usa.com', 'vip', 'FashionHub USA', ?)").run(user.id, now);
});
tx();

const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE mailbox_id = ?').get(MB).n;
console.log(`tester seeded: ${n} messages, role=tester`);
db.close();
