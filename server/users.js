import { db, now } from './db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './security.js';
import { sanitizeGlossary } from './glossary.js';

/** 空闲超时：超过此时间未活动则会话失效（滑动窗口） */
const SESSION_IDLE_TTL = Number(process.env.SESSION_IDLE_DAYS || 14) * 24 * 3600 * 1000;
/** 绝对上限：自创建起最长存活，防止无限续期 */
const SESSION_ABS_TTL = Number(process.env.SESSION_ABS_DAYS || 30) * 24 * 3600 * 1000;

const LAYOUT_MODES = new Set(['standard', 'sales', 'focus']);
const clampInt = (n, min, max, fallback) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.round(x)));
};

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
  /** 发信后认领：auto 自动认领客户 / off 关闭 */
  sendAutoClaim: 'auto',
  remindOverdue: true,
  translateTarget: '简体中文',
  autoTranslate: false,
  /**
   * 是否允许把邮件正文发往云端 AI（摘要/翻译/润色/分诊等）。
   * 关闭后服务端拒绝云端 AI 接口；密钥仍可在服务器配置。
   */
  aiCloudOk: true,
  glossary: [],
  /** 布局：standard 标准三栏 / sales 销售台 / focus 专注读信 */
  layoutMode: 'standard',
  layoutSidebar: 252,
  layoutList: 360,
  layoutCustomer: 280,
};

function sanitizeLayout(merged) {
  if ('layoutMode' in merged) merged.layoutMode = LAYOUT_MODES.has(merged.layoutMode) ? merged.layoutMode : 'standard';
  if ('layoutSidebar' in merged) merged.layoutSidebar = clampInt(merged.layoutSidebar, 180, 320, 252);
  if ('layoutList' in merged) merged.layoutList = clampInt(merged.layoutList, 280, 520, 360);
  if ('layoutCustomer' in merged) merged.layoutCustomer = clampInt(merged.layoutCustomer, 240, 380, 280);
  if ('sendAutoClaim' in merged) merged.sendAutoClaim = merged.sendAutoClaim === 'off' ? 'off' : 'auto';
  if ('aiCloudOk' in merged) merged.aiCloudOk = merged.aiCloudOk !== false && merged.aiCloudOk !== 0;
}


export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    totpEnabled: !!(u.totp_enabled && u.totp_enc),
    settings: (() => {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(u.settings || '{}') };
      s.glossary = sanitizeGlossary(s.glossary);
      if (s.translateTarget !== 'English' && s.translateTarget !== '英文') s.translateTarget = '简体中文';
      else s.translateTarget = 'English';
      s.autoTranslate = !!s.autoTranslate;
      s.aiCloudOk = s.aiCloudOk !== false && s.aiCloudOk !== 0;
      sanitizeLayout(s);
      return s;
    })(),
  };
}

export const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

// 平台登录账号：邮箱地址，或 3–32 位的用户名（字母、数字、. _ -）
const loginId = (v) => String(v || '').trim().toLowerCase();
const validLoginId = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || /^[a-z0-9][a-z0-9._-]{2,31}$/.test(v);

/** 密码：至少 8 位，且同时含字母与数字 */
export function assertPasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) throw new Error('密码至少 8 位');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Error('密码需同时包含字母和数字');
  return p;
}

export function createUser({ email, name, password, role = 'member' }) {
  const id = loginId(email);
  if (!validLoginId(id)) throw new Error('账号请填写邮箱地址，或 3–32 位的字母、数字用户名');
  assertPasswordStrength(password);
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
  assertPasswordStrength(newPassword);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
}

export function resetPassword(userId, newPassword) {
  assertPasswordStrength(newPassword);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function updateSettings(userId, patch) {
  const u = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
  const merged = { ...JSON.parse(u.settings || '{}'), ...patch };
  for (const k of Object.keys(merged)) if (!(k in DEFAULT_SETTINGS)) delete merged[k];
  if ('glossary' in merged) merged.glossary = sanitizeGlossary(merged.glossary);
  if ('translateTarget' in merged) {
    const t = String(merged.translateTarget || '').trim();
    merged.translateTarget = t === 'English' || t === '英文' ? 'English' : '简体中文';
  }
  if ('autoTranslate' in merged) merged.autoTranslate = !!merged.autoTranslate;
  if ('aiCloudOk' in merged) {
    merged.aiCloudOk = merged.aiCloudOk !== false && merged.aiCloudOk !== 0;
    if (!merged.aiCloudOk) {
      merged.autoSummary = false;
      merged.autoTranslate = false;
    }
  }
  sanitizeLayout(merged);
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(merged), userId);
  const settings = { ...DEFAULT_SETTINGS, ...merged };
  settings.glossary = sanitizeGlossary(settings.glossary);
  sanitizeLayout(settings);
  return settings;
}

export const settingsOf = (userId) => publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId))?.settings || { ...DEFAULT_SETTINGS };

export function updateProfile(userId, { name }) {
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), userId);
}

/** 登录成功后默认吊销同账号其它会话（可用 SESSION_REVOKE_OTHERS_ON_LOGIN=0 关闭） */
const REVOKE_OTHERS_ON_LOGIN = process.env.SESSION_REVOKE_OTHERS_ON_LOGIN !== '0';

export function createSession(userId, userAgent, { revokeOthers = REVOKE_OTHERS_ON_LOGIN } = {}) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now(),
    now(),
    String(userAgent || '').slice(0, 200)
  );
  if (revokeOthers) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(token));
  }
  return token;
}

export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s) return null;
  const t = now();
  if (t - s.last_seen > SESSION_IDLE_TTL || t - s.created_at > SESSION_ABS_TTL) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
    return null;
  }
  if (t - s.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(t, s.token_hash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** 注销其他设备；keepToken 为当前会话则保留 */
export function destroyOtherSessions(userId, keepToken) {
  if (keepToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken)).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function listSessions(userId, currentToken) {
  const cur = currentToken ? sha256(currentToken) : '';
  return db
    .prepare(
      `SELECT token_hash, created_at, last_seen, user_agent FROM sessions
       WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20`
    )
    .all(userId)
    .map((s) => ({
      current: s.token_hash === cur,
      createdAt: s.created_at,
      lastSeen: s.last_seen,
      userAgent: s.user_agent || '',
    }));
}

export const sessionPolicy = () => ({
  idleDays: Math.round(SESSION_IDLE_TTL / (24 * 3600 * 1000)),
  absDays: Math.round(SESSION_ABS_TTL / (24 * 3600 * 1000)),
});

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

export { sanitizeGlossary };
