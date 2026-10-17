import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db } from './db.js';
import { encryptBuffer, decryptBuffer } from './security.js';

/** 备份目录：DATA_DIR/backups（与 WAL 同盘，不碰运行中的 mail.db） */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 6) * 3600_000;
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
/** 默认加密备份；BACKUP_PLAIN=1 可写明文（仅应急） */
const ENCRYPT = process.env.BACKUP_PLAIN !== '1';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(BACKUP_DIR, 0o700);
  } catch {
    /* Windows 可能忽略 */
  }
}

function chmodFile(fp) {
  try {
    fs.chmodSync(fp, 0o600);
  } catch {
    /* ignore */
  }
}

/** 用 better-sqlite3 在线 backup API：不打断 WAL；默认写成 .db.enc */
export async function backupOnce() {
  ensureDir();
  const base = `mail-${stamp()}`;
  const dest = path.join(BACKUP_DIR, ENCRYPT ? `${base}.db.enc` : `${base}.db`);
  const tmp = path.join(BACKUP_DIR, `${base}.db.tmp`);
  try {
    await db.backup(tmp);
    if (ENCRYPT) {
      const plain = fs.readFileSync(tmp);
      fs.writeFileSync(dest, encryptBuffer(plain), { mode: 0o600 });
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    } else {
      fs.renameSync(tmp, dest);
    }
    chmodFile(dest);
    prune();
    console.log(`[backup] 已写入 ${path.basename(dest)}${ENCRYPT ? '（加密）' : ''}`);
    return dest;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** 将加密备份还原为明文 .db（运维用，不自动调用） */
export function restoreEncryptedBackup(encPath, outPath) {
  const buf = fs.readFileSync(encPath);
  const plain = decryptBuffer(buf);
  fs.writeFileSync(outPath, plain, { mode: 0o600 });
  return outPath;
}

function listBackupFiles() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^mail-.*\.db(\.enc)?$/.test(f))
      .map((f) => {
        const fp = path.join(BACKUP_DIR, f);
        return { f, t: fs.statSync(fp).mtimeMs, p: fp };
      })
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
}

/** 最近一次成功备份的 mtime（ISO），无则 null — 供 /api/health */
export function lastBackupAt() {
  const files = listBackupFiles();
  if (!files.length) return null;
  return new Date(files[0].t).toISOString();
}

function prune() {
  for (const { p } of listBackupFiles().slice(KEEP)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** 启动后延迟一次，再按间隔定时；失败只打日志，不影响主服务 */
export function startBackupScheduler() {
  const run = () => backupOnce().catch((e) => console.error('[backup]', e.message || e));
  setTimeout(run, 90_000).unref();
  setInterval(run, INTERVAL_MS).unref();
  console.log(
    `[backup] 定时备份已启用：每 ${INTERVAL_MS / 3600_000}h，保留最近 ${KEEP} 份，${ENCRYPT ? '加密' : '明文'} → ${BACKUP_DIR}`
  );
}
