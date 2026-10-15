// 演示数据：向已绑定的测试邮箱写入外贸客户往来邮件（仅用于演示「今日待办 / 智能分拣」）
// 用法：node scripts/seed-demo.mjs [登录邮箱] [登录密码]
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { db } from '../server/db.js';
import { decrypt } from '../server/security.js';

const [login = 'admin@zito.test', password = 'Passw0rd!'] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:3310/api';
const H = 3600_000;
const now = Date.now();
const todayAt = (h, m = 0) => new Date(new Date().setHours(h, m, 0, 0)).getTime();
const ago = (hours) => now - hours * H;

const user = db.prepare('SELECT * FROM users WHERE email = ?').get(login);
if (!user) throw new Error('找不到用户 ' + login);
const [A, B] = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? ORDER BY sort, created_at').all(user.id);
if (!A) throw new Error('该用户还没有绑定邮箱');
if (db.prepare("SELECT 1 FROM messages WHERE message_id = 'dj2405-confirm@fashionhub-usa.com'").get()) {
  console.log('演示数据已存在，跳过写入');
  process.exit(0);
}

const me = (mb) => ({ name: mb.name || 'Sales', address: mb.email });
const folderOf = (mb, use) => db.prepare('SELECT path FROM folders WHERE mailbox_id = ? AND special_use = ?').get(mb.id, use)?.path;

// [邮箱, 文件夹, 已读, 邮件]
const plan = [];
const add = (mb, use, seen, m) => plan.push({ mb, use, seen, m });

// 1. VIP 客户确认订单（今天）
add(A, '\\Sent', true, {
  from: me(A), to: 'Mike Johnson <mike@fashionhub-usa.com>', date: ago(6 * 24), messageId: '<dj2405-quote@zito.demo>',
  subject: "Quotation - Women's Denim Jacket Style #DJ-2405",
  text: "Dear Mike,\n\nPlease find our quotation for style DJ-2405 below:\n- FOB Ningbo USD 12.80/pc\n- MOQ 1,000 pcs per color\n- Lead time 45 days after deposit\n\nLooking forward to your feedback.\n\nBest regards,\nAlice",
});
add(A, '\\Inbox', false, {
  from: 'Mike Johnson <mike@fashionhub-usa.com>', to: me(A), date: ago(2.2), messageId: '<dj2405-confirm@fashionhub-usa.com>',
  inReplyTo: '<dj2405-quote@zito.demo>', references: '<dj2405-quote@zito.demo>',
  subject: "Re: Quotation - Women's Denim Jacket Style #DJ-2405",
  text: "Hi Alice,\n\nGood news - we'd like to confirm the order for 3,000 pcs (1,500 indigo / 1,500 black). Please send the PI ASAP so we can arrange the 30% deposit this week.\n\nCan you ship by Nov 30?\n\nThanks,\nMike Johnson\nSourcing Manager, FashionHub USA",
});

// 2. 老客户质量投诉（30 小时前，已读未回 —— 典型的「看过就忘」）
add(A, '\\Sent', true, {
  from: me(A), to: 'Hans Weber <h.weber@modehaus.de>', date: ago(12 * 24), messageId: '<po4471-ship@zito.demo>',
  subject: 'PO#4471 shipment notice', text: 'Dear Hans,\n\nPO#4471 (1,200 navy hoodies) was shipped today. B/L and packing list attached.\n\nBest regards,\nAlice',
});
add(A, '\\Inbox', true, {
  from: 'Hans Weber <h.weber@modehaus.de>', to: me(A), date: ago(30), messageId: '<po4471-claim@modehaus.de>',
  inReplyTo: '<po4471-ship@zito.demo>', references: '<po4471-ship@zito.demo>',
  subject: 'Re: PO#4471 shipment notice - quality issue',
  text: 'Dear Alice,\n\nWe received the goods but found color shading on about 200 pcs of the navy hoodies. Photos attached. This is not acceptable for our stores.\n\nPlease advise how you will handle this claim.\n\nRegards,\nHans Weber\nModehaus GmbH',
});

// 3. 新客户询盘（40 分钟前）
add(A, '\\Inbox', false, {
  from: 'Sarah Lindqvist <sarah@nordicwear.se>', to: me(A), date: ago(0.7), messageId: '<inq-organic-tee@nordicwear.se>',
  subject: 'Inquiry: Organic cotton T-shirts - 5,000 pcs',
  text: 'Hello,\n\nWe are a Swedish brand looking for a supplier of GOTS-certified organic cotton T-shirts, around 5,000 pcs for our first order.\n\nCould you send your best FOB price and MOQ? Do you offer custom woven labels?\n\nBest,\nSarah Lindqvist\nNordic Wear AB',
});

// 4. 老客户样品反馈（昨天）
add(A, '\\Sent', true, {
  from: me(A), to: 'Emma Clarke <emma@urbanthreads.co.uk>', date: ago(5 * 24), messageId: '<ss25-cargo-fit@zito.demo>',
  subject: 'Fit sample for SS25 cargo pants', text: 'Hi Emma,\n\nThe fit sample for SS25 cargo pants has been sent by DHL. Please share your comments.\n\nAlice',
});
add(A, '\\Inbox', true, {
  from: 'Emma Clarke <emma@urbanthreads.co.uk>', to: me(A), date: ago(20), messageId: '<ss25-cargo-comments@urbanthreads.co.uk>',
  inReplyTo: '<ss25-cargo-fit@zito.demo>', references: '<ss25-cargo-fit@zito.demo>',
  subject: 'Re: Fit sample for SS25 cargo pants',
  text: 'Hi Alice,\n\nThe fit sample looks good overall, but the waist needs +1 cm and the pocket flap is a bit short.\n\nCould you send a revised PP sample by next Friday?\n\nCheers,\nEmma',
});

// 5. 已回复的客户（今天已处理）
add(A, '\\Inbox', true, {
  from: 'Lisa Tran <lisa@greenleaf.com.au>', to: me(A), date: ago(26), messageId: '<linen-swatch@greenleaf.com.au>',
  subject: 'Swatch request for linen blend', text: 'Hi Alice, could you send swatches of your 55/45 linen-cotton blend in natural and sage? Thanks, Lisa',
});
add(A, '\\Sent', true, {
  from: me(A), to: 'Lisa Tran <lisa@greenleaf.com.au>', date: Math.max(todayAt(9, 10), ago(1)), messageId: '<linen-swatch-re@zito.demo>',
  inReplyTo: '<linen-swatch@greenleaf.com.au>', references: '<linen-swatch@greenleaf.com.au>',
  subject: 'Re: Swatch request for linen blend', text: 'Hi Lisa, swatches in natural and sage will be dispatched tomorrow. Tracking number to follow. Alice',
});

// 6. 我发出后对方一直没回 —— 待跟进
add(A, '\\Sent', true, {
  from: me(A), to: 'Carlos Ruiz <carlos@modaiberica.es>', date: ago(4 * 24 + 3), messageId: '<polo-offer@zito.demo>',
  subject: 'Quotation for knitted polo shirts - 2,000 pcs',
  text: 'Dear Carlos,\n\nAttached is our offer for 2,000 pcs knitted polo shirts, FOB Shanghai USD 6.40/pc.\n\nCould you confirm the colors and size ratio so we can lock the fabric?\n\nBest regards,\nAlice',
});
add(A, '\\Sent', true, {
  from: me(A), to: 'Yuki Tanaka <yuki@tokyostyle.jp>', date: ago(3 * 24 + 6), messageId: '<samples-dhl@zito.demo>',
  subject: 'Samples dispatched via DHL - AWB 1234567890',
  text: 'Hi Yuki,\n\nThe 6 samples you requested were dispatched today via DHL, AWB 1234567890.\n\nCould you confirm receipt when they arrive?\n\nAlice',
});

// 7. 一周前的展会询盘，至今未回
add(A, '\\Inbox', false, {
  from: 'David Kim <david.kim.buyer@gmail.com>', to: me(A), date: ago(3 * 24 + 2), messageId: '<catalog-req@gmail.com>',
  subject: 'Catalogue request after Canton Fair',
  text: 'Hi, we met at your booth at the Canton Fair. Could you send your latest catalogue and price list for yoga wear? Thanks, David',
});

// 8. 通知与订阅（应自动降权）
add(A, '\\Inbox', false, {
  from: 'DHL Express <noreply@dhl.com>', to: me(A), date: ago(1.5), messageId: '<awb-1234567890@dhl.com>',
  subject: 'Shipment update: AWB 1234567890 delivered', text: 'Your shipment AWB 1234567890 has been delivered.',
});
add(A, '\\Inbox', false, {
  from: 'Textile Weekly <news@textileweekly.com>', to: me(A), date: ago(5), messageId: '<tw-issue-42@textileweekly.com>',
  subject: 'This week: cotton prices hit 3-month high', text: 'Market news and trends for apparel sourcing professionals.',
  headers: { 'List-Unsubscribe': '<https://textileweekly.com/unsub>' },
});

// 9. 第二个邮箱：客户发来定金水单
if (B) {
  add(B, '\\Sent', true, {
    from: me(B), to: 'Ahmed Al-Rashid <ahmed@dubaitextiles.ae>', date: ago(8 * 24), messageId: '<pi-5520@zito.demo>',
    subject: 'Proforma Invoice PO#5520', text: 'Dear Ahmed,\n\nPlease find the proforma invoice for PO#5520 attached.\n\nBest regards,\nBob',
  });
  add(B, '\\Inbox', false, {
    from: 'Ahmed Al-Rashid <ahmed@dubaitextiles.ae>', to: me(B), date: ago(1.1), messageId: '<deposit-5520@dubaitextiles.ae>',
    inReplyTo: '<pi-5520@zito.demo>', references: '<pi-5520@zito.demo>',
    subject: 'Re: Proforma Invoice PO#5520 - deposit paid, TT copy attached',
    text: 'Dear Bob,\n\nPlease find attached the TT copy for the 30% deposit of PO#5520. Kindly confirm receipt and start production.\n\nBest regards,\nAhmed Al-Rashid\nDubai Textiles LLC',
  });
}

const build = (m) =>
  new Promise((resolve, reject) =>
    new MailComposer({ ...m, date: new Date(m.date) }).compile().build((err, buf) => (err ? reject(err) : resolve(buf)))
  );

for (const mb of [A, B].filter(Boolean)) {
  const items = plan.filter((p) => p.mb === mb);
  if (!items.length) continue;
  const client = new ImapFlow({
    host: mb.imap_host, port: mb.imap_port, secure: !!mb.imap_secure,
    auth: { user: mb.login_user || mb.email, pass: decrypt(mb.pass_enc) }, logger: false,
  });
  await client.connect();
  for (const p of items) {
    const path = folderOf(mb, p.use) || (p.use === '\\Inbox' ? 'INBOX' : null);
    if (!path) throw new Error(`${mb.email} 缺少文件夹 ${p.use}`);
    await client.append(path, await build(p.m), p.seen ? ['\\Seen'] : [], new Date(p.m.date));
    console.log(`  + ${mb.email} ${p.use.slice(1)}  ${p.m.subject}`);
  }
  await client.logout();
}

// 触发同步，并把 FashionHub 设为 VIP 客户
let cookie = '';
const call = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'x-zm': '1', 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body || {}),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
};
await call('/auth/login', { email: login, password });
await call('/sender-rules', { key: '@fashionhub-usa.com', kind: 'vip', name: 'FashionHub USA' });
for (const mb of [A, B].filter(Boolean)) await call(`/mailboxes/${mb.id}/sync`);
console.log('演示数据写入完成，正在同步…');
