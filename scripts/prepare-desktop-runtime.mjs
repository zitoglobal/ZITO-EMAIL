/**
 * 把当前构建机的 node.exe 拷进 desktop/runtime，供安装包内启动服务（与 better-sqlite3 ABI 一致）。
 */
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('desktop/runtime');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, process.platform === 'win32' ? 'node.exe' : 'node');
fs.copyFileSync(process.execPath, dest);
console.log('[desktop-runtime] copied', process.execPath, '->', dest);
console.log('[desktop-runtime] node', process.version);
