import crypto from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { db } from './db.js';
import { decrypt, encrypt, randomToken, sha256 } from './security.js';

const ISSUER = 'ZITO Mail';
const PENDING_TTL = 5 * 60_000;
const RECOVERY_COUNT = 8;
const pendingLogins = new Map(); // ticketHash -> { userId, exp }

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pendingLogins) if (v.exp < t) pendingLogins.delete(k);
}, 60_000).unref();

function normalizeCode(token) {
  return String(token || '')
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .toUpperCase();
}

function makeRecoveryCodes(n = RECOVERY_COUNT) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

function storeRecoveryHashes(userId, plainCodes) {
  const hashes = plainCodes.map((c) => sha256(normalizeCode(c)));
  db.prepare('UPDATE users SET totp_recovery_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(hashes)), userId);
}

function loadRecoveryHashes(userId) {
  const u = db.prepare('SELECT totp_recovery_enc FROM users WHERE id = ?').get(userId);
  if (!u?.totp_recovery_enc) return [];
  try {
    const arr = JSON.parse(decrypt(u.totp_recovery_enc));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 校验并消耗一条备用码；成功返回 true */
function consumeRecoveryCode(userId, token) {
  const norm = normalizeCode(token);
  if (norm.length < 8) return false;
  const hashes = loadRecoveryHashes(userId);
  const hit = sha256(norm);
  const idx = hashes.indexOf(hit);
  if (idx < 0) return false;
  hashes.splice(idx, 1);
  db.prepare('UPDATE users SET totp_recovery_enc = ? WHERE id = ?').run(
    hashes.length ? encrypt(JSON.stringify(hashes)) : null,
    userId
  );
  return true;
}

function verifyTotpOrRecovery(userId, secret, token) {
  const raw = String(token || '').replace(/\s/g, '');
  if (/^\d{6}$/.test(raw)) {
    const result = verifySync({ token: raw, secret });
    if (result?.valid) return { ok: true, via: 'totp' };
  }
  if (consumeRecoveryCode(userId, raw)) return { ok: true, via: 'recovery' };
  return { ok: false };
}

export function userTotpStatus(userId) {
  const u = db.prepare('SELECT totp_enabled, totp_enc, totp_recovery_enc FROM users WHERE id = ?').get(userId);
  const recoveryLeft = u?.totp_recovery_enc ? loadRecoveryHashes(userId).length : 0;
  return {
    enabled: !!(u?.totp_enabled && u?.totp_enc),
    configured: !!u?.totp_enc,
    recoveryLeft,
  };
}

export async function beginSetup(userId, loginId) {
  const secret = generateSecret();
  const uri = generateURI({ issuer: ISSUER, label: String(loginId || 'user'), secret });
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
  db.prepare('UPDATE users SET totp_enc = ?, totp_enabled = 0, totp_recovery_enc = NULL WHERE id = ?').run(encrypt(secret), userId);
  return { uri, qrDataUrl, secret };
}

export function confirmSetup(userId, token) {
  const u = db.prepare('SELECT totp_enc FROM users WHERE id = ?').get(userId);
  if (!u?.totp_enc) throw Object.assign(new Error('请先开始绑定验证器'), { status: 400 });
  const secret = decrypt(u.totp_enc);
  const result = verifySync({ token: String(token || '').replace(/\s/g, ''), secret });
  if (!result?.valid) throw Object.assign(new Error('验证码不正确，请重试'), { status: 400 });
  const recoveryCodes = makeRecoveryCodes();
  storeRecoveryHashes(userId, recoveryCodes);
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
  return { enabled: true, recoveryCodes };
}

export function regenerateRecovery(userId, token) {
  const u = db.prepare('SELECT totp_enc, totp_enabled FROM users WHERE id = ?').get(userId);
  if (!u?.totp_enabled || !u.totp_enc) throw Object.assign(new Error('请先开启二次验证'), { status: 400 });
  const secret = decrypt(u.totp_enc);
  const check = verifyTotpOrRecovery(userId, secret, token);
  if (!check.ok) throw Object.assign(new Error('验证码或备用码不正确'), { status: 400 });
  const recoveryCodes = makeRecoveryCodes();
  storeRecoveryHashes(userId, recoveryCodes);
  return { recoveryCodes, recoveryLeft: recoveryCodes.length };
}

export function disable(userId, token) {
  const u = db.prepare('SELECT totp_enc, totp_enabled FROM users WHERE id = ?').get(userId);
  if (!u?.totp_enabled) {
    db.prepare('UPDATE users SET totp_enc = NULL, totp_enabled = 0, totp_recovery_enc = NULL WHERE id = ?').run(userId);
    return { enabled: false };
  }
  const secret = decrypt(u.totp_enc);
  const check = verifyTotpOrRecovery(userId, secret, token);
  if (!check.ok) throw Object.assign(new Error('验证码或备用码不正确'), { status: 400 });
  db.prepare('UPDATE users SET totp_enc = NULL, totp_enabled = 0, totp_recovery_enc = NULL WHERE id = ?').run(userId);
  return { enabled: false };
}

export function createLoginTicket(userId) {
  const ticket = randomToken(24);
  pendingLogins.set(sha256(ticket), { userId, exp: Date.now() + PENDING_TTL });
  return ticket;
}

export function consumeLoginTicket(ticket, token) {
  const key = sha256(String(ticket || ''));
  const pend = pendingLogins.get(key);
  if (!pend || pend.exp < Date.now()) {
    pendingLogins.delete(key);
    throw Object.assign(new Error('登录已超时，请重新输入密码'), { status: 401 });
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(pend.userId);
  if (!u?.totp_enabled || !u.totp_enc) {
    pendingLogins.delete(key);
    throw Object.assign(new Error('该账号未开启二次验证'), { status: 400 });
  }
  const secret = decrypt(u.totp_enc);
  const check = verifyTotpOrRecovery(u.id, secret, token);
  if (!check.ok) throw Object.assign(new Error('验证码或备用码不正确'), { status: 401 });
  pendingLogins.delete(key);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  const recoveryLeft = loadRecoveryHashes(u.id).length;
  return { user, via: check.via, recoveryLeft };
}

export function isTotpEnabled(userRow) {
  return !!(userRow?.totp_enabled && userRow?.totp_enc);
}
