import crypto from 'node:crypto';

export const GLOSSARY_MAX = 50;
export const GLOSSARY_FIELD_MAX = 80;

/** Trim, length-cap, dedupe, and strip control chars from glossary rows. */
export function sanitizeGlossary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const src = String(row.src ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, GLOSSARY_FIELD_MAX);
    const dst = String(row.dst ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, GLOSSARY_FIELD_MAX);
    if (!src || !dst) continue;
    const key = src.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src, dst });
    if (out.length >= GLOSSARY_MAX) break;
  }
  return out;
}

/** Stable hash for translate-cache keys (order-independent). */
export function glossaryHash(raw) {
  const entries = sanitizeGlossary(raw)
    .slice()
    .sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** 外贸常用术语一键预设（写入用户术语表时再 sanitize）。 */
export const TRADE_GLOSSARY_PRESET = [
  { src: 'MOQ', dst: '最小起订量' },
  { src: 'FOB', dst: '离岸价（船上交货）' },
  { src: 'CIF', dst: '到岸价（成本+保险+运费）' },
  { src: 'EXW', dst: '工厂交货价' },
  { src: 'CFR', dst: '成本加运费' },
  { src: 'Lab Dip', dst: '色样 / 确认色' },
  { src: 'PP sample', dst: '产前样' },
  { src: 'SMS', dst: '推销样' },
  { src: 'Bulk', dst: '大货' },
  { src: 'Lead time', dst: '交货周期' },
  { src: 'PO', dst: '采购订单' },
  { src: 'PI', dst: '形式发票' },
  { src: 'SKU', dst: '货号 / 库存单位' },
  { src: 'OEM', dst: '贴牌生产' },
  { src: 'ODM', dst: '设计代工' },
  { src: 'QC', dst: '质检' },
  { src: 'T/T', dst: '电汇' },
  { src: 'L/C', dst: '信用证' },
];
