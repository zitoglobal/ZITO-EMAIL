import fs from 'node:fs';
import path from 'node:path';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import * as repo from './repo.js';
import * as imap from './imap.js';
import * as sync from './sync.js';
import { sendMail } from './smtp.js';
import { emit } from './events.js';
import { DATA_DIR, db } from './db.js';
import * as deals from './deals.js';
import * as users from './users.js';
import * as priority from './priority.js';
import { inlineDataImagesInHtml, mergeInlineAttachments } from './mail_mime.js';

export const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');

/** 瞬时 SMTP/网络错误：可自动退避重试（非认证/拒信） */
export function isTransientSmtpError(msg) {
  return /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket|network|temporar|421|450|451|452|try again/i.test(
    String(msg || '')
  );
}

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
  // Outlook/企业网关常剥 HTML 内 data:image；抽成 cid 内联附件
  const { html, attachments: inlineAtt } = inlineDataImagesInHtml(payload.html || '');
  return {
    to: parseRecipients(payload.to),
    cc: parseRecipients(payload.cc),
    bcc: parseRecipients(payload.bcc),
    subject: payload.subject || '',
    html,
    text: payload.text,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    attachments: mergeInlineAttachments(attachments, inlineAtt),
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
      try {
        repo.markThreadAnswered(mb.user_id, {
          threadId: orig.thread_id || payload.replyTo.threadId,
          inReplyTo: mail.inReplyTo || orig.message_id,
          messageId: orig.message_id,
        });
      } catch {
        /* best-effort */
      }
    }
  } else if (mail.inReplyTo) {
    try {
      repo.markThreadAnswered(mb.user_id, { inReplyTo: mail.inReplyTo, threadId: payload.threadId });
    } catch {
      /* best-effort */
    }
  }
  if (payload.draftUid) {
    const drafts = repo.specialFolder(mb.id, '\\Drafts');
    if (drafts) jobs.push(imap.expungeMessages(mb, drafts.path, [Number(payload.draftUid)]));
  }
  await Promise.allSettled(jobs);
  repo.addContacts(mb.user_id, [...mail.to, ...mail.cc, ...mail.bcc], 3);
  priority.invalidate(mb.user_id);
  // 近实时：发信后立刻拉 Sent，尽量让「等对方」马上可见
  if (sent) {
    try {
      await sync.forceSync(mb.id, sent.path);
    } catch {
      /* 异步兜底 */
      sync.forceSync(mb.id, sent.path).catch(() => {});
    }
    priority.invalidate(mb.user_id);
    sync.touch(mb.id, sent.path, 2500);
  }
  const drafts = repo.specialFolder(mb.id, '\\Drafts');
  if (payload.draftUid && drafts) sync.touch(mb.id, drafts.path);
  emit(mb.user_id, 'sync', { mailboxId: mb.id, folder: sent?.path, local: true, sent: true });
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

function safeOutboxChild(dir, name) {
  const base = String(name || '');
  if (!/^\d+$/.test(base)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, base);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

export function loadOutboxFiles(dir) {
  if (!dir) return [];
  const root = path.resolve(dir);
  const outRoot = path.resolve(OUTBOX_DIR);
  const outPrefix = outRoot.endsWith(path.sep) ? outRoot : outRoot + path.sep;
  if (root !== outRoot && !root.startsWith(outPrefix)) return [];
  if (!fs.existsSync(root)) return [];
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(meta)) return [];
  return meta
    .map((m) => {
      const fp = safeOutboxChild(root, m.file);
      if (!fp || !fs.existsSync(fp)) return null;
      return {
        filename: String(m.filename || 'file').slice(0, 200),
        contentType: String(m.contentType || 'application/octet-stream').slice(0, 120),
        content: fs.readFileSync(fp),
      };
    })
    .filter(Boolean);
}

export function removeOutboxFiles(dir) {
  if (!dir) return;
  const root = path.resolve(dir);
  const outRoot = path.resolve(OUTBOX_DIR);
  const outPrefix = outRoot.endsWith(path.sep) ? outRoot : outRoot + path.sep;
  if (root === outRoot || root.startsWith(outPrefix)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------- 后台调度 ----------
const SEND_HARD_TIMEOUT_MS = 120_000;
const STALE_SENDING_MS = 180_000;
let sendBusy = false;

function reclaimStaleSending() {
  const stale = repo.reclaimStaleOutboxSending(STALE_SENDING_MS);
  for (const r of stale) {
    emit(r.userId, 'outbox', { id: r.id, status: 'failed', error: r.error });
  }
  return stale.length;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || `操作超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function processOutbox() {
  for (const job of repo.dueOutbox()) {
    const claimedAt = repo.claimOutboxSending(job.id);
    if (claimedAt == null) continue;
    const mb = repo.getMailboxById(job.mailbox_id);
    try {
      const payload = JSON.parse(job.payload);
      await withTimeout(deliver(mb, payload, loadOutboxFiles(job.files_dir)), SEND_HARD_TIMEOUT_MS, '发送超时（120s）');
      const finished = repo.finishOutboxIfClaim(job.id, claimedAt);
      if (finished) {
        removeOutboxFiles(job.files_dir);
        emit(job.user_id, 'outbox', { id: job.id, status: 'sent' });
      } else {
        // 已被超时回收或用户重试；SMTP 可能已成功——勿删用户新任务
        console.warn('[outbox] deliver ok but claim gone', job.id);
      }
      try {
        const settings = users.settingsOf(job.user_id);
        if (settings.sendAutoClaim !== 'off') {
          const selfEmails = repo.listMailboxes(job.user_id).map((m) => m.email).filter(Boolean);
          const meta = deals.afterOutboundSend(job.user_id, payload, { mode: 'auto', selfEmails });
          if (meta?.claimed || meta?.conflict) {
            for (const u of users.listUsers()) emit(u.id, 'sync', { local: true, deal: true });
          }
        }
      } catch (e) {
        console.warn('[deals] outbox claim', e.message);
      }
    } catch (e) {
      const msg = e.message || String(e);
      const transient = isTransientSmtpError(msg);
      const tries = Number(job.tries || 0) + 1;
      if (transient && tries <= 2) {
        const delay = tries === 1 ? 30_000 : 120_000;
        const sendAt = Date.now() + delay;
        if (repo.scheduleOutboxRetryIfClaim(job.id, claimedAt, sendAt, tries, msg)) {
          emit(job.user_id, 'outbox', { id: job.id, status: 'retry', tries, error: msg, sendAt });
        }
      } else if (repo.failOutboxIfClaim(job.id, claimedAt, msg)) {
        emit(job.user_id, 'outbox', { id: job.id, status: 'failed', error: msg });
      }
    }
  }
}

function processSnoozes() {
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
}

async function tick() {
  reclaimStaleSending();
  // 稍后提醒不因发信卡住而停
  try {
    processSnoozes();
  } catch (e) {
    console.error('[scheduler] snooze', e);
  }
  if (sendBusy) return;
  sendBusy = true;
  try {
    await processOutbox();
  } finally {
    sendBusy = false;
  }
}

export function startScheduler() {
  // 崩溃时 sending 可能已 SMTP 成功：勿自动重发，标 failed 让用户核对已发送
  db.prepare(
    `UPDATE outbox SET status = 'failed', error = ?
     WHERE status = 'sending'`
  ).run('上次发送中断，请到「已发送」确认是否已发出后再重试');
  // 1.5s：缩短撤销窗口与真正发出的竞态
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 1_500).unref();
  setInterval(() => repo.pruneBodies(), 3600_000).unref();
}

/** 单测用：导出回收逻辑 */
export { reclaimStaleSending, STALE_SENDING_MS };
