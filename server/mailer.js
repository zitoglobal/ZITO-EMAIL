import fs from 'node:fs';
import path from 'node:path';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import * as repo from './repo.js';
import * as imap from './imap.js';
import * as sync from './sync.js';
import { sendMail } from './smtp.js';
import { emit } from './events.js';
import { DATA_DIR, db } from './db.js';

export const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');

export function parseRecipients(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v.join(',') : String(v);
  return addressparser(list.replace(/[;，；]/g, ','), { flatten: true })
    .filter((x) => x.address && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.address))
    .map((x) => (x.name ? { name: x.name, address: x.address } : { name: '', address: x.address }));
}

/** 把前端提交的 payload + 文件整理成 nodemailer 需要的结构 */
export async function buildMail(mb, payload, files) {
  const attachments = files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType }));
  if (payload.forward?.id) {
    const [src] = repo.getMessagesForUser(mb.user_id, [Number(payload.forward.id)]);
    if (src) {
      const srcMb = repo.getMailboxById(src.mailbox_id);
      for (const idx of payload.forward.indexes || []) {
        const a = await imap.getAttachment(srcMb, src.folder, src.uid, idx);
        attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
      }
    }
  }
  return {
    to: parseRecipients(payload.to),
    cc: parseRecipients(payload.cc),
    bcc: parseRecipients(payload.bcc),
    subject: payload.subject || '',
    html: payload.html,
    text: payload.text,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    attachments,
  };
}

/** 真正发出邮件，并完成写入已发送 / 标记已回复 / 删除草稿 / 记录联系人 */
export async function deliver(mb, payload, files) {
  const mail = await buildMail(mb, payload, files);
  if (!mail.to.length && !mail.cc.length && !mail.bcc.length) throw new Error('请填写至少一个有效收件人');
  const raw = await sendMail(mb, mail);

  const sent = repo.specialFolder(mb.id, '\\Sent');
  const jobs = [];
  if (!mb.auto_saves_sent && sent) jobs.push(imap.appendMessage(mb, sent.path, raw, ['\\Seen']));
  if (payload.replyTo?.id) {
    const [orig] = repo.getMessagesForUser(mb.user_id, [Number(payload.replyTo.id)]);
    if (orig) {
      repo.patchMessages([orig.id], { answered: 1 });
      jobs.push(imap.setFlags(repo.getMailboxById(orig.mailbox_id), orig.folder, [orig.uid], { answered: true }));
    }
  }
  if (payload.draftUid) {
    const drafts = repo.specialFolder(mb.id, '\\Drafts');
    if (drafts) jobs.push(imap.expungeMessages(mb, drafts.path, [Number(payload.draftUid)]));
  }
  await Promise.allSettled(jobs);
  repo.addContacts(mb.user_id, [...mail.to, ...mail.cc, ...mail.bcc], 3);
  if (sent) sync.touch(mb.id, sent.path);
  const drafts = repo.specialFolder(mb.id, '\\Drafts');
  if (payload.draftUid && drafts) sync.touch(mb.id, drafts.path);
}

export function saveOutboxFiles(files) {
  if (!files.length) return null;
  const dir = path.join(OUTBOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const meta = files.map((f, i) => {
    const file = path.join(dir, String(i));
    fs.writeFileSync(file, f.content);
    return { filename: f.filename, contentType: f.contentType, file: String(i) };
  });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

export function loadOutboxFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  return meta.map((m) => ({ filename: m.filename, contentType: m.contentType, content: fs.readFileSync(path.join(dir, m.file)) }));
}

export function removeOutboxFiles(dir) {
  if (dir && dir.startsWith(OUTBOX_DIR)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 后台调度 ----------
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const job of repo.dueOutbox()) {
      repo.setOutboxStatus(job.id, 'sending');
      const mb = repo.getMailboxById(job.mailbox_id);
      try {
        await deliver(mb, JSON.parse(job.payload), loadOutboxFiles(job.files_dir));
        repo.deleteOutbox(job.id);
        removeOutboxFiles(job.files_dir);
        emit(job.user_id, 'outbox', { id: job.id, status: 'sent' });
      } catch (e) {
        repo.setOutboxStatus(job.id, 'failed', e.message);
        emit(job.user_id, 'outbox', { id: job.id, status: 'failed', error: e.message });
      }
    }

    const due = repo.dueSnoozes();
    for (const m of due) {
      repo.patchMessages([m.id], { snooze_until: null, sort_ts: Date.now(), seen: 0 });
      const mb = repo.getMailboxById(m.mailbox_id);
      imap.setFlags(mb, m.folder, [m.uid], { seen: false }).catch(() => {});
      emit(m.user_id, 'new', {
        mailboxId: m.mailbox_id,
        snooze: true,
        count: 1,
        items: [{ id: m.id, subject: m.subject, from: { name: m.from_name, address: m.from_addr } }],
      });
      emit(m.user_id, 'sync', { mailboxId: m.mailbox_id, folder: m.folder });
    }
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  db.prepare("UPDATE outbox SET status = 'scheduled' WHERE status = 'sending'").run();
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 5_000).unref();
  setInterval(() => repo.pruneBodies(), 3600_000).unref();
}
