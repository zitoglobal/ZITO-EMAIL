import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, db, now } from './db.js';

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

function loadOrCreateVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@zitoglobal.com',
    };
  }
  try {
    if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch {
    /* regenerate */
  }
  const keys = webpush.generateVAPIDKeys();
  const data = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@zitoglobal.com',
  };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(data, null, 2));
  return data;
}

const vapid = loadOrCreateVapid();
webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

export function publicKey() {
  return vapid.publicKey;
}

export function saveSubscription(userId, sub, userAgent = '') {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!endpoint || !p256dh || !auth) throw Object.assign(new Error('无效的推送订阅'), { status: 400 });
  const t = now();
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       updated_at = excluded.updated_at`
  ).run(userId, endpoint, p256dh, auth, String(userAgent || '').slice(0, 200), t, t);
  return { ok: true };
}

export function removeSubscription(userId, endpoint) {
  if (endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  } else {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  }
  return { ok: true };
}

export function listForUser(userId) {
  return db.prepare('SELECT id, endpoint, created_at AS createdAt FROM push_subscriptions WHERE user_id = ?').all(userId);
}

/** 向用户所有订阅推送；失效订阅自动清理 */
export async function notifyUser(userId, payload) {
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!rows.length) return { sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        body,
        { TTL: 3600, urgency: payload.urgency || 'normal' }
      );
      sent++;
    } catch (e) {
      const code = e.statusCode || e.status;
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
      } else {
        console.warn('[push]', e.message);
      }
    }
  }
  return { sent };
}
