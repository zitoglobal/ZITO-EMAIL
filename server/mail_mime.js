/**
 * 发信 MIME：把 HTML 内 data:image 抽成 cid 附件，避免 Outlook/企业网关裂图或拒收。
 */

const DATA_IMG_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+)\2/gi;

const EXT = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
};

/** 单张上限（与签名压缩策略一致，过大跳过保留原 data URL） */
const MAX_BYTES = 900_000;
const MAX_IMAGES = 24;

/**
 * @param {string} html
 * @returns {{ html: string, attachments: Array<{ filename: string, content: Buffer, contentType: string, cid: string, contentDisposition: string }> }}
 */
export function inlineDataImagesInHtml(html) {
  const src = String(html || '');
  if (!/data:image\//i.test(src)) return { html: src, attachments: [] };

  const attachments = [];
  let n = 0;
  const out = src.replace(DATA_IMG_RE, (full, pre, quote, dataUrl, kind) => {
    if (n >= MAX_IMAGES) return full;
    const m = String(dataUrl).match(/^data:image\/([a-z0-9+.-]+);base64,([\s\S]+)$/i);
    if (!m) return full;
    const subtype = String(m[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
    const b64 = String(m[2] || '').replace(/\s+/g, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return full;
    }
    if (!buf.length || buf.length > MAX_BYTES) return full;
    n += 1;
    const cid = `zm-inline-${Date.now().toString(36)}-${n}@zito.mail`;
    const ext = EXT[subtype] || 'png';
    const contentType = `image/${subtype === 'jpg' ? 'jpeg' : subtype}`;
    attachments.push({
      filename: `inline-${n}.${ext}`,
      content: buf,
      contentType,
      cid,
      contentDisposition: 'inline',
    });
    return `${pre}${quote}cid:${cid}${quote}`;
  });

  return { html: out, attachments };
}

/** 合并到既有 attachments（cid 内联放前面，便于部分客户端解析） */
export function mergeInlineAttachments(existing = [], inline = []) {
  if (!inline.length) return existing || [];
  return [...inline, ...(existing || [])];
}
