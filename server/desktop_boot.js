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

export function readDesktopConfig() {
  const p = desktopConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function writeDesktopConfig(patch = {}) {
  const home = desktopHome();
  fs.mkdirSync(home, { recursive: true });
  const next = { ...readDesktopConfig(), ...patch };
  const p = desktopConfigPath();
  fs.writeFileSync(p, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 可能忽略 */
  }
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
