import React, { useEffect, useMemo, useRef, useState } from 'react';
import { textToHtml } from '../utils.js';

const FRAME_STYLE = `
  html,body{margin:0;padding:0;background:transparent}
  body{display:flow-root}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65;color:#1f2330;word-wrap:break-word;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  table{max-width:100%}
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

export default function MailFrame({ html, text, dark, allowImages = true, collapseQuotes = false }) {
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

  const imgSrc = allowImages ? 'img-src * data: blob: cid:' : 'img-src data: blob: cid:';
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline' *; font-src * data:; ${imgSrc}; media-src *"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}${
    dark && !html ? ':root{color-scheme:dark}body{color:#e6e8f0}a{color:#a5b4fc}' : ':root{color-scheme:light}'
  }</style></head><body>${content}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro;
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
      // 部分邮件字体/图片晚到，短时再量几次
      const tick = () => {
        measure();
        if (++tries < 6) setTimeout(tick, 120 * tries);
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
    // srcDoc 在部分浏览器不会二次触发 load，主动测一次
    requestAnimationFrame(measure);
    return () => {
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [doc]);

  return (
    <div className="mail-frame-shell">
      {html && !empty ? (
        <span className="mail-trust-badge" title="脚本已禁用 · 外链新窗口打开 · 不泄露平台 Cookie">
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
