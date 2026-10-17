import React, { useEffect, useMemo, useRef, useState } from 'react';
import { textToHtml } from '../utils.js';

const FRAME_STYLE = `
  html,body{margin:0;padding:0;background:transparent}
  body{display:flow-root}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65;color:#1f2330;word-wrap:break-word;overflow-wrap:anywhere}
  img{max-width:100%!important;height:auto;display:inline-block;cursor:zoom-in}
  img.zm-broken{
    cursor:default;outline:1px dashed #c5cad6;min-width:72px;min-height:48px;
    background:repeating-linear-gradient(-45deg,#f4f5f8,#f4f5f8 6px,#eef0f5 6px,#eef0f5 12px);
    object-fit:none;padding:8px;box-sizing:border-box;
  }
  table{max-width:100%!important;border-collapse:collapse;table-layout:auto}
  td,th{word-break:break-word;overflow-wrap:anywhere;vertical-align:top}
  caption{caption-side:top;text-align:left;padding:4px 0;font-weight:600}
  pre{white-space:pre-wrap}
  blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d8dbe6;color:#5b6172}
  a{color:#4f46e5}
  .zm-hidden-quote{display:none!important}
`;

const QUOTE_SELECTOR = '.gmail_quote, blockquote[type="cite"], .zm-quote, .zm-forward, #divRplyFwdMsg, #isReplyContent, .yahoo_quoted, #reply-content, .ms-outlook-mobile-reference-message';

/** 把引用部分（以及之后的内容）标记为隐藏，返回是否存在引用；只改 body 片段，勿返回整页 html */
function markQuotes(html) {
  if (!html) return { html, hasQuote: false };
  const doc = new DOMParser().parseFromString(`<div id="zm-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('zm-root') || doc.body;
  const first = root.querySelector(QUOTE_SELECTOR);
  if (!first) return { html, hasQuote: false };
  const textBefore = (() => {
    const range = doc.createRange();
    range.setStart(root, 0);
    range.setEndBefore(first);
    return range.toString().trim();
  })();
  if (!textBefore) return { html, hasQuote: false };
  first.classList.add('zm-hidden-quote');
  let n = first.nextElementSibling;
  while (n) {
    n.classList.add('zm-hidden-quote');
    n = n.nextElementSibling;
  }
  return { html: root.innerHTML, hasQuote: true };
}

function hasVisibleBody(html, text) {
  const t = String(text || '').replace(/\s+/g, '').trim();
  if (t) return true;
  const h = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, '')
    .trim();
  return !!h;
}

function wireImages(doc, { onImageClick, onBrokenChange }) {
  if (!doc) return () => {};
  const imgs = [...doc.querySelectorAll('img')];
  const broken = new Set();
  const report = () => onBrokenChange?.(broken.size, imgs.length);

  const cleanups = imgs.map((img) => {
    const onErr = () => {
      img.classList.add('zm-broken');
      if (!img.getAttribute('alt')) img.setAttribute('alt', '图片加载失败');
      broken.add(img);
      // 同源附件偶发失败：自动重试一次
      const src = img.getAttribute('src') || '';
      if (/^\/api\/messages\/\d+\/attachments\//i.test(src) && !img.dataset.zmRetry) {
        img.dataset.zmRetry = '1';
        const u = src.includes('?') ? `${src}&_r=${Date.now()}` : `${src}?_r=${Date.now()}`;
        img.src = u;
        return;
      }
      report();
    };
    const onOk = () => {
      img.classList.remove('zm-broken');
      broken.delete(img);
      report();
    };
    const onClick = (e) => {
      if (img.classList.contains('zm-broken')) return;
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:image/gif;base64,R0lGOD')) return; // 追踪像素极小图可略过放大
      if (img.naturalWidth > 0 && img.naturalWidth <= 3 && img.naturalHeight <= 3) return;
      e.preventDefault();
      e.stopPropagation();
      onImageClick?.({ src, alt: img.alt || '' });
    };
    img.addEventListener('error', onErr);
    img.addEventListener('load', onOk);
    img.addEventListener('click', onClick);
    if (img.complete && img.naturalWidth === 0) onErr();
    return () => {
      img.removeEventListener('error', onErr);
      img.removeEventListener('load', onOk);
      img.removeEventListener('click', onClick);
    };
  });
  report();
  return () => cleanups.forEach((fn) => fn());
}

export default function MailFrame({
  html,
  text,
  dark,
  allowImages = true,
  collapseQuotes = false,
  onImageClick,
  onBrokenChange,
}) {
  const ref = useRef();
  const [height, setHeight] = useState(40);
  const [showQuote, setShowQuote] = useState(false);

  const { content, hasQuote, empty } = useMemo(() => {
    const rawHtml = html && String(html).trim() ? html : '';
    const rawText = text && String(text).trim() ? text : '';
    if (!hasVisibleBody(rawHtml, rawText)) {
      return {
        content: `<div style="color:#8b91a1;font-size:13px">（此邮件无正文内容，可能仅为附件或空信）</div>`,
        hasQuote: false,
        empty: true,
      };
    }
    const raw = rawHtml || `<div style="white-space:normal">${textToHtml(rawText)}</div>`;
    if (!collapseQuotes || showQuote) return { content: raw, hasQuote: false, empty: false };
    const r = markQuotes(raw);
    return { content: r.html, hasQuote: r.hasQuote, empty: false };
  }, [html, text, collapseQuotes, showQuote]);

  // 始终放行同源附件 URL（大图 CID → /api/.../attachments），与「外部图片」策略解耦
  const imgSrc = allowImages
    ? "img-src 'self' https: http: data: blob: cid:"
    : "img-src 'self' data: blob: cid:";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline' *; font-src * data:; ${imgSrc}; media-src 'self' data: blob:"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}${
    dark && !html ? ':root{color-scheme:dark}body{color:#e6e8f0}a{color:#a5b4fc}' : ':root{color-scheme:light}'
  }</style></head><body>${content}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro;
    let unwire = () => {};
    let tries = 0;
    const measure = () => {
      try {
        const b = frame.contentDocument?.body;
        if (b) setHeight(Math.max(40, b.scrollHeight + 6));
      } catch {
        // 跨域时忽略
      }
    };
    const onLoad = () => {
      measure();
      unwire();
      try {
        unwire = wireImages(frame.contentDocument, { onImageClick, onBrokenChange });
      } catch {
        unwire = () => {};
      }
      const tick = () => {
        measure();
        if (++tries < 8) setTimeout(tick, 100 * tries);
      };
      setTimeout(tick, 50);
      try {
        ro = new ResizeObserver(measure);
        if (frame.contentDocument?.body) ro.observe(frame.contentDocument.body);
        frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
      } catch {
        // ignore
      }
    };
    frame.addEventListener('load', onLoad);
    requestAnimationFrame(measure);
    // srcDoc 更新后部分浏览器不触发 load
    const t = setTimeout(onLoad, 30);
    return () => {
      clearTimeout(t);
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
      unwire();
    };
  }, [doc, onImageClick, onBrokenChange]);

  return (
    <div className="mail-frame-shell">
      {html && !empty ? (
        <span className="mail-trust-badge" title="脚本已禁用 · 外链新窗口打开 · 内嵌图可点击放大">
          已隔离
        </span>
      ) : null}
      <iframe
        ref={ref}
        title="mail-body"
        className={'mail-frame' + (html && !empty ? ' html' : '')}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ height }}
      />
      {hasQuote && (
        <button className="quote-toggle" onClick={() => setShowQuote(true)} title="显示引用内容">
          •••
        </button>
      )}
    </div>
  );
}
