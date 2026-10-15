import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db } from './db.js';

/** 备份目录：DATA_DIR/backups（与 WAL 同盘，不碰运行中的 mail.db） */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 6) * 3600_000;
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 用 better-sqlite3 在线 backup API：不打断 WAL，不拷贝 -wal/-shm */
export async function backupOnce() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `mail-${stamp()}.db`);
  const tmp = dest + '.tmp';
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, dest);
    prune();
    console.log(`[backup] 已写入 ${path.basename(dest)}`);
    return dest;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
}

function prune() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^mail-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    } catch (_) {}
  }
}

/** 启动后延迟一次，再按间隔定时；失败只打日志，不影响主服务 */
export function startBackupScheduler() {
  const run = () =>
    backupOnce().catch((e) => console.error('[backup]', e.message || e));
  setTimeout(run, 90_000).unref();
  setInterval(run, INTERVAL_MS).unref();
  console.log(`[backup] 定时备份已启用：每 ${INTERVAL_MS / 3600_000}h，保留最近 ${KEEP} 份 → ${BACKUP_DIR}`);
}
