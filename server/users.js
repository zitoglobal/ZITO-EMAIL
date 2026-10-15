import { db, now } from './db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './security.js';

const SESSION_TTL = 30 * 24 * 3600 * 1000;

const DEFAULT_SETTINGS = {
  theme: 'light',
  autoSummary: false,
  notify: true,
  undoSeconds: 5,
  remoteImages: 'contacts',
  density: 'comfortable',
  readingPane: 'right',
  conversationView: true,
  replySlaHours: 24,
  slaVipHours: 4,
  slaCustomerHours: 24,
  slaNewInquiryHours: 8,
  followupDays: 3,
  remindOverdue: true,
};

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(u.settings || '{}') },
  };
}

export const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

// 平台登录账号：邮箱地址，或 3–32 位的用户名（字母、数字、. _ -）
const loginId = (v) => String(v || '').trim().toLowerCase();
const validLoginId = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || /^[a-z0-9][a-z0-9._-]{2,31}$/.test(v);

export function createUser({ email, name, password, role = 'member' }) {
  const id = loginId(email);
  if (!validLoginId(id)) throw new Error('账号请填写邮箱地址，或 3–32 位的字母、数字用户名');
  if (String(password || '').length < 8) throw new Error('密码至少 8 位');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(id)) throw new Error('该账号已存在');
  const info = db
    .prepare('INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, (name || '').trim() || id.split('@')[0], hashPassword(password), role, now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function authenticate(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(loginId(email));
  if (!u || !verifyPassword(password, u.pass_hash)) return null;
  return u;
}

export function changePassword(userId, oldPassword, newPassword, keepToken) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!verifyPassword(oldPassword, u.pass_hash)) throw new Error('原密码不正确');
  if (String(newPassword || '').length < 8) throw new Error('新密码至少 8 位');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
}

export function resetPassword(userId, newPassword) {
  if (String(newPassword || '').length < 8) throw new Error('新密码至少 8 位');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function updateSettings(userId, patch) {
  const u = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
  const merged = { ...JSON.parse(u.settings || '{}'), ...patch };
  for (const k of Object.keys(merged)) if (!(k in DEFAULT_SETTINGS)) delete merged[k];
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(merged), userId);
  return { ...DEFAULT_SETTINGS, ...merged };
}

export const settingsOf = (userId) => publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId))?.settings || { ...DEFAULT_SETTINGS };

export function updateProfile(userId, { name }) {
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), userId);
}

export function createSession(userId, userAgent) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now(),
    now(),
    String(userAgent || '').slice(0, 200)
  );
  return token;
}

export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s) return null;
  if (now() - s.last_seen > SESSION_TTL) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
    return null;
  }
  if (now() - s.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), s.token_hash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function listUsers() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.created_at,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.user_id = u.id) AS mailboxes
       FROM users u ORDER BY u.id`
    )
    .all();
}

export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
