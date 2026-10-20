/** 深搜每文件夹最多带回的新 UID（从新到旧） */
export const DEEP_PER_FOLDER = 200;
/** 除收件箱 / 已发送 / 归档外，再带上最近同步的客户夹 */
export const DEEP_EXTRA_FOLDERS = 8;

const PRIMARY = new Set(['\\Inbox', '\\Sent', '\\Archive']);
const SKIP_EXTRA = new Set(['\\Inbox', '\\Sent', '\\Archive', '\\Junk', '\\Trash', '\\Drafts']);

/**
 * 服务器全文要扫哪些文件夹。
 * 当前已在某个文件夹时只搜该夹；否则搜 Inbox/Sent/Archive，再加最近同步的客户夹（跳过垃圾/草稿/已删除）。
 */
export function foldersForDeepSearch(folders, { box, folder } = {}) {
  const list = Array.isArray(folders) ? folders : [];
  if (box === 'folder') return list.filter((f) => f && f.path === folder);
  const primary = list.filter((f) => f && PRIMARY.has(f.special_use));
  const extra = list
    .filter((f) => f && f.path && f.last_sync && !SKIP_EXTRA.has(f.special_use || ''))
    .sort((a, b) => (b.last_sync || 0) - (a.last_sync || 0))
    .slice(0, DEEP_EXTRA_FOLDERS);
  const seen = new Set();
  const out = [];
  for (const f of [...primary, ...extra]) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}
