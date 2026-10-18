import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

const w = 256;
const h = 256;
const raw = Buffer.alloc((w * 4 + 1) * h);
for (let y = 0; y < h; y++) {
  raw[y * (w * 4 + 1)] = 0;
  for (let x = 0; x < w; x++) {
    const i = y * (w * 4 + 1) + 1 + x * 4;
    const cx = x - w / 2;
    const cy = y - h / 2;
    const on = cx * cx + cy * cy <= (w * 0.38) ** 2;
    raw[i] = on ? 10 : 255;
    raw[i + 1] = on ? 102 : 255;
    raw[i + 2] = on ? 255 : 255;
    raw[i + 3] = 255;
  }
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.resolve('desktop/icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length);
