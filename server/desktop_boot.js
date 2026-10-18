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
  fs.writeFileSync(desktopConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 同步应用桌面环境；非桌面模式为空操作 */
export function applyDesktopEnv() {
  if (!IS_DESKTOP) return { applied: false };

  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
  if (process.env.COOKIE_SECURE == null || process.env.COOKIE_SECURE === '') {
    process.env.COOKIE_SECURE = '0';
  }
  // 桌面首装允许创建管理员；已有用户后仍走 signupMode
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

  if (!process.env.AI_API_KEY && cfg.aiApiKey) {
    process.env.AI_API_KEY = String(cfg.aiApiKey);
  }
  if (!process.env.AI_BASE_URL && cfg.aiBaseUrl) {
    process.env.AI_BASE_URL = String(cfg.aiBaseUrl);
  }
  if (!process.env.PORT && cfg.port) {
    process.env.PORT = String(cfg.port);
  }

  return {
    applied: true,
    home,
    dataDir: process.env.DATA_DIR,
    configPath: desktopConfigPath(),
  };
}

// 作为 side-effect import 时立即生效
export const desktopBootInfo = applyDesktopEnv();
if (IS_DESKTOP && desktopBootInfo.applied) {
  console.log(
    `[desktop] home=${desktopBootInfo.home} data=${desktopBootInfo.dataDir} bind=${process.env.BIND_HOST || '127.0.0.1'}`
  );
}
