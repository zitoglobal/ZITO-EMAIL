/**
 * Windows / 本机托盘版启动引导。
 * 必须作为 server 入口的第一个 import，以便在 db/security 读环境变量之前生效。
 *
 * 触发：ZITO_DESKTOP=1
 * 数据：%APPDATA%/ZITO-EMAIL（可用 ZITO_HOME 覆盖）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function truthy(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export const IS_DESKTOP = truthy(process.env.ZITO_DESKTOP);

function defaultHome() {
  if (process.env.ZITO_HOME) return path.resolve(process.env.ZITO_HOME);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'ZITO-EMAIL');
  }
  return path.join(os.homedir(), '.zito-email');
}

export function desktopHome() {
  return defaultHome();
}

export function desktopConfigPath() {
  return path.join(desktopHome(), 'config.json');
}

/** 本机派生密钥封装敏感字段（防 config.json 明文被顺手复制） */
const SEAL_PREFIX = 'd1.';
const SECRET_KEYS = ['mailSecret', 'desktopToken', 'aiApiKey'];

function deskSealKey() {
  let user = 'user';
  try {
    user = os.userInfo().username || user;
  } catch {
    /* ignore */
  }
  return crypto.createHash('sha256').update(`zm-desk-v1|${user}|${os.homedir()}|${desktopHome()}`).digest();
}

export function sealDesktopSecret(plain) {
  const s = String(plain ?? '');
  if (!s || s.startsWith(SEAL_PREFIX)) return s;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deskSealKey(), iv);
  const enc = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    SEAL_PREFIX +
    [iv, tag, enc]
      .map((b) => b.toString('base64'))
      .join('.')
  );
}

export function unsealDesktopSecret(payload) {
  const s = String(payload ?? '');
  if (!s.startsWith(SEAL_PREFIX)) return s;
  try {
    const parts = s.slice(SEAL_PREFIX.length).split('.');
    if (parts.length !== 3) return '';
    const [iv, tag, enc] = parts.map((x) => Buffer.from(x, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', deskSealKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function decodeConfigSecrets(raw) {
  const out = { ...raw };
  for (const k of SECRET_KEYS) {
    if (out[k] != null && out[k] !== '') out[k] = unsealDesktopSecret(out[k]);
  }
  return out;
}

function encodeConfigSecrets(obj) {
  const out = { ...obj };
  for (const k of SECRET_KEYS) {
    if (out[k] != null && out[k] !== '') out[k] = sealDesktopSecret(out[k]);
  }
  return out;
}

export function readDesktopConfig() {
  const p = desktopConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    return decodeConfigSecrets(raw);
  } catch {
    return {};
  }
}

export function writeDesktopConfig(patch = {}) {
  const home = desktopHome();
  fs.mkdirSync(home, { recursive: true });
  const next = { ...readDesktopConfig(), ...patch };
  const p = desktopConfigPath();
  const sealed = encodeConfigSecrets(next);
  fs.writeFileSync(p, JSON.stringify(sealed, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 可能忽略 */
  }
  // 读回已解封视图，调用方拿到明文
  return next;
}

/** 同步应用桌面环境；非桌面模式为空操作 */
export function applyDesktopEnv() {
  if (!IS_DESKTOP) return { applied: false };

  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  // 默认只绑本机；显式 DESKTOP_ALLOW_LAN=1 才允许改 BIND_HOST（局域网版）
  if (!truthy(process.env.DESKTOP_ALLOW_LAN)) {
    process.env.BIND_HOST = '127.0.0.1';
  } else {
    process.env.BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
  }
  if (process.env.COOKIE_SECURE == null || process.env.COOKIE_SECURE === '') {
    process.env.COOKIE_SECURE = '0';
  }
  // 首装开放注册；有用户后默认关闭（可用 SIGNUP_CODE / ALLOW_SIGNUP=1 覆盖）
  if (process.env.ALLOW_SIGNUP == null || process.env.ALLOW_SIGNUP === '') {
    process.env.ALLOW_SIGNUP = '1';
  }
  if (process.env.ADMIN_TOTP_REQUIRED == null || process.env.ADMIN_TOTP_REQUIRED === '') {
    process.env.ADMIN_TOTP_REQUIRED = '0';
  }

  const home = desktopHome();
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;

  const cfg = readDesktopConfig();
  if (!process.env.MAIL_SECRET || !String(process.env.MAIL_SECRET).trim()) {
    if (cfg.mailSecret && String(cfg.mailSecret).trim()) {
      process.env.MAIL_SECRET = String(cfg.mailSecret).trim();
    } else {
      const secret = crypto.randomBytes(32).toString('hex');
      writeDesktopConfig({ mailSecret: secret });
      process.env.MAIL_SECRET = secret;
    }
  } else if (!cfg.mailSecret) {
    writeDesktopConfig({ mailSecret: process.env.MAIL_SECRET });
  }

  // 托盘本机调用用的短令牌（勿进前端）
  if (!cfg.desktopToken || String(cfg.desktopToken).length < 32) {
    writeDesktopConfig({ desktopToken: crypto.randomBytes(32).toString('hex') });
  }

  if (!process.env.AI_API_KEY && cfg.aiApiKey) {
    process.env.AI_API_KEY = String(cfg.aiApiKey);
  }
  if (!process.env.AI_BASE_URL && cfg.aiBaseUrl) {
    process.env.AI_BASE_URL = String(cfg.aiBaseUrl);
  }
  if (!process.env.PORT && cfg.port) {
    process.env.PORT = String(cfg.port);
  }

  try {
    fs.chmodSync(desktopConfigPath(), 0o600);
  } catch {
    /* Windows 可能忽略 */
  }

  // 旧版明文密钥 → 封装重写（幂等）
  try {
    const p = desktopConfigPath();
    if (fs.existsSync(p)) {
      const disk = JSON.parse(fs.readFileSync(p, 'utf8'));
      const needsSeal = SECRET_KEYS.some((k) => disk[k] && !String(disk[k]).startsWith(SEAL_PREFIX));
      if (needsSeal) writeDesktopConfig({});
    }
  } catch {
    /* ignore */
  }

  return {
    applied: true,
    home,
    dataDir: process.env.DATA_DIR,
    configPath: desktopConfigPath(),
  };
}

/** 托盘 / 本机特权接口令牌 */
export function desktopLocalToken() {
  if (!IS_DESKTOP) return '';
  const cfg = readDesktopConfig();
  return String(cfg.desktopToken || '').trim();
}

// 作为 side-effect import 时立即生效
export const desktopBootInfo = applyDesktopEnv();
if (IS_DESKTOP && desktopBootInfo.applied) {
  console.log(
    `[desktop] home=${desktopBootInfo.home} data=${desktopBootInfo.dataDir} bind=${process.env.BIND_HOST || '127.0.0.1'}`
  );
}
