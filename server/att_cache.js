/**
 * 附件磁盘缓存：缩略图 / 灯箱重复打开不必再打 IMAP。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const ROOT = path.join(DATA_DIR, 'att-cache');
const MAX_FILES = 2500;
const MAX_BYTES = 800 * 1024 * 1024; // ~800MB

function filePaths(messagePk, index) {
  const dir = path.join(ROOT, String(messagePk));
  const base = String(Number(index));
  return {
    dir,
    bin: path.join(dir, `${base}.bin`),
    meta: path.join(dir, `${base}.json`),
  };
}

export function readAttCache(messagePk, index) {
  try {
    const { bin, meta } = filePaths(messagePk, index);
    if (!fs.existsSync(bin) || !fs.existsSync(meta)) return null;
    const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const content = fs.readFileSync(bin);
    // 触碰 mtime，便于 LRU 清理
    const now = new Date();
    fs.utimesSync(bin, now, now);
    fs.utimesSync(meta, now, now);
    return {
      filename: info.filename || 'attachment',
      contentType: info.contentType || 'application/octet-stream',
      content,
      etag: info.etag || `${messagePk}-${index}-${content.length}`,
    };
  } catch {
    return null;
  }
}

export function writeAttCache(messagePk, index, { filename, contentType, content }) {
  try {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    if (!buf.length || buf.length > 40 * 1024 * 1024) return null; // 过大不落盘
    const { dir, bin, meta } = filePaths(messagePk, index);
    fs.mkdirSync(dir, { recursive: true });
    const etag = `${messagePk}-${index}-${buf.length}`;
    fs.writeFileSync(bin, buf);
    fs.writeFileSync(
      meta,
      JSON.stringify({
        filename: filename || 'attachment',
        contentType: contentType || 'application/octet-stream',
        etag,
        size: buf.length,
        at: Date.now(),
      })
    );
    pruneAttCache();
    return etag;
  } catch (e) {
    console.warn('[att-cache] write', e.message);
    return null;
  }
}

/** 按 mtime 淘汰最旧文件 */
export function pruneAttCache() {
  try {
    if (!fs.existsSync(ROOT)) return;
    const files = [];
    for (const msgDir of fs.readdirSync(ROOT)) {
      const abs = path.join(ROOT, msgDir);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!name.endsWith('.bin')) continue;
        const bin = path.join(abs, name);
        try {
          const s = fs.statSync(bin);
          files.push({ bin, meta: bin.replace(/\.bin$/, '.json'), mtime: s.mtimeMs, size: s.size });
        } catch {
          /* ignore */
        }
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((s, f) => s + f.size, 0);
    while (files.length > MAX_FILES || total > MAX_BYTES) {
      const f = files.shift();
      if (!f) break;
      try {
        fs.unlinkSync(f.bin);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(f.meta);
      } catch {
        /* ignore */
      }
      total -= f.size;
    }
  } catch (e) {
    console.warn('[att-cache] prune', e.message);
  }
}

export function attCacheEtag(messagePk, index, size) {
  return `"${messagePk}-${index}-${size || 0}"`;
}
