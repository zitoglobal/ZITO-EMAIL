// 端到端测试：node scripts/e2e.mjs <邮箱A> <密码A> <邮箱B> <密码B>
// 使用 Ethereal 测试邮箱（nodemailer.createTestAccount）时需手动指定 SMTP 587
const B = process.env.BASE || 'http://localhost:3310/api';
let cookie = '';
async function call(path, { method = 'GET', body, form } = {}) {
  const headers = { 'x-zm': '1', cookie };
  let payload;
  if (form) payload = form;
  else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(B + path, { method, headers, body: payload });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = t.slice(0, 80);
  }
  if (r.status >= 400) d = { status: r.status, ...d };
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => console.log(k.padEnd(16), typeof v === 'string' ? v : JSON.stringify(v).slice(0, 260));
const ok = (cond, label) => console.log(cond ? '  ✓' : '  ✗ 失败', label);
const [ua, pa, ub, pb] = process.argv.slice(2);
const eth = { imapHost: 'imap.ethereal.email', imapPort: 993, imapSecure: true, smtpHost: 'smtp.ethereal.email', smtpPort: 587, smtpSecure: false };

async function waitFor(fn, label, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  console.log('  ✗ 超时', label);
  return null;
}

log('status', await call('/auth/status'));
const reg = await call('/auth/register', { method: 'POST', body: { email: 'admin@zito.test', name: '管理员', password: 'Passw0rd!' } });
if (reg.status) log('login', await call('/auth/login', { method: 'POST', body: { email: 'admin@zito.test', password: 'Passw0rd!' } }));
else log('register', reg);

const A = (await call('/mailboxes', { method: 'POST', body: { email: ua, password: pa, name: 'Alice', advanced: eth } })).mailbox;
const Bm = (await call('/mailboxes', { method: 'POST', body: { email: ub, password: pb, name: 'Bob', advanced: eth } })).mailbox;
ok(A && Bm, '绑定两个邮箱');
const me = await call('/me');
ok(me.mailboxes.length >= 2, `me 返回 ${me.mailboxes.length} 个邮箱`);

await waitFor(async () => (await call('/state')).mailboxes.every((m) => m.status === 'ok'), '首次同步');
const st = await call('/state');
log('folders A', st.folders[A.id].map((f) => `${f.specialUse || f.path}:${f.total}`));

// 发信：A → B，带 5 秒撤销窗口，先撤销再发送
const mk = (subject, extra = {}) => {
  const fd = new FormData();
  fd.append('payload', JSON.stringify({ mailboxId: A.id, to: `Bob <${ub}>`, subject, html: `<p>${subject} 正文 报价 quotation</p>`, text: subject, ...extra }));
  fd.append('files', new Blob(['附件内容']), '规格书.txt');
  return fd;
};
const s1 = await call('/send', { method: 'POST', form: mk('撤销测试', { delaySeconds: 5 }) });
ok(s1.outboxId, '进入发送队列');
const undo = await call(`/outbox/${s1.outboxId}`, { method: 'DELETE' });
ok(undo.ok && undo.payload?.subject === '撤销测试', '撤销发送');
const s2 = await call('/send', { method: 'POST', form: mk('多邮箱联调 Inquiry') });
ok(s2.sent, '立即发送');
const sched = await call('/send', { method: 'POST', form: mk('定时发送测试', { sendAt: Date.now() + 8000 }) });
ok(sched.scheduled, '定时发送已排队');
log('outbox', (await call('/outbox')).items.map((i) => `${i.subject}:${i.status}`));

// Ethereal 不真正投递，而是把外发邮件存回发件人收件箱
const fdB = new FormData();
fdB.append('payload', JSON.stringify({ mailboxId: Bm.id, to: ua, subject: 'Bob 发出的邮件', html: '<p>hi</p>' }));
ok((await call('/send', { method: 'POST', form: fdB })).sent, 'B 邮箱发信');

const got = await waitFor(async () => {
  const l = await call(`/messages?mailboxId=all&box=inbox`);
  return l.messages?.find((m) => m.subject === '多邮箱联调 Inquiry');
}, '收到邮件（IDLE 推送）');
ok(got, '统一收件箱出现新邮件（无需手动刷新）');
const gotB = await waitFor(async () => (await call(`/messages?mailboxId=all&box=inbox`)).messages?.find((m) => m.subject === 'Bob 发出的邮件'), 'B');
ok(gotB && gotB.mailboxId === Bm.id && got.mailboxId === A.id, '统一收件箱同时包含两个邮箱的邮件');
if (!got) process.exit(1);

const detail = await call(`/messages/${got.id}`);
ok(detail.html?.includes('报价') && detail.attachments?.length === 1, '读取正文与附件');
const thread = await call(`/messages/${got.id}/thread`);
ok(thread.messages?.length >= 1, `会话 ${thread.messages?.length} 封`);

ok((await call('/messages?box=inbox&q=' + encodeURIComponent('from:alice has:attachment'))).messages?.length >= 1, '搜索语法 from: has:attachment');
ok((await call('/messages?box=inbox&deep=1&q=quotation')).messages?.length >= 1, '服务器端全文搜索');

ok((await call('/messages/actions', { method: 'POST', body: { ids: [got.id], action: 'flag' } })).ok, '星标');
ok((await call('/messages?box=flagged')).messages.some((m) => m.id === got.id), '星标视图');
ok((await call('/messages/actions', { method: 'POST', body: { ids: [got.id], action: 'pin' } })).ok, '置顶');
ok((await call('/messages?box=inbox')).pinned.some((m) => m.id === got.id), '置顶列表');

const arch = await call('/messages/actions', { method: 'POST', body: { ids: [got.id], action: 'archive' } });
ok(arch.ok, `归档（可撤销：${arch.undoable}）`);
if (arch.undoable) {
  const back = await call('/messages/actions', { method: 'POST', body: { ids: [got.id], action: 'restore', origins: { [got.id]: got.folder } } });
  ok(back.ok, '撤销归档');
}
ok((await call('/messages/actions', { method: 'POST', body: { ids: [got.id], action: 'snooze', until: Date.now() + 6000 } })).ok, '稍后提醒 6 秒');
ok((await call('/messages?box=snoozed')).messages.some((m) => m.id === got.id), '稍后处理视图');

const dfd = new FormData();
dfd.append('payload', JSON.stringify({ mailboxId: A.id, to: 'x@example.com', subject: '草稿测试', html: '<p>draft</p>' }));
ok((await call('/drafts', { method: 'POST', form: dfd })).ok, '保存草稿');

ok((await call('/templates', { method: 'POST', body: { name: '报价回复', subject: 'Quotation', body: 'Dear {{name}}' } })).id, '新建模板');
log('contacts', (await call('/contacts?q=' + encodeURIComponent(ub.slice(0, 4)))).contacts);

await sleep(9000);
const inboxNow = await call('/messages?box=inbox');
ok([...inboxNow.messages, ...inboxNow.pinned].some((m) => m.id === got.id && !m.seen), '稍后提醒到期回到收件箱并标为未读');
ok(!(await call('/outbox')).items.some((i) => i.subject === '定时发送测试'), '定时邮件已发出');

const member = `sales${Date.now()}@zito.test`;
ok((await call('/admin/users', { method: 'POST', body: { email: member, name: '业务员', password: 'Passw0rd!' } })).user, '管理员创建成员');
const memberRow = (await call('/admin/users')).users.find((u) => u.email === member);
ok((await call(`/admin/users/${memberRow.id}`, { method: 'DELETE' })).ok, '管理员删除成员');
log('users', (await call('/admin/users')).users.map((u) => `${u.email}:${u.role}:${u.mailboxes}`));
log('counts', (await call('/state')).counts);
