import sanitizeHtml from 'sanitize-html';
import { enrichAnchorAttribs } from './mail_links.js';

/** 允许的邮件内联样式（禁 url()/expression 等外泄与脚本面） */
const STYLE_SIZE = [/^\d+(?:\.\d+)?(?:px|em|rem|pt|%)?$/i];
const STYLE_COLOR = [
  /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgb\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)$/i,
  /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)$/i,
  /^hsl\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*\)$/i,
  /^[a-z]{1,20}$/i,
];
const STYLE_ALIGN = [/^(?:left|right|center|justify|start|end)$/i];
const STYLE_DISPLAY = [/^(?:inline|block|inline-block|none|table|table-row|table-cell|flex)$/i];

const ALLOWED_STYLES = {
  '*': {
    color: STYLE_COLOR,
    'background-color': STYLE_COLOR,
    'text-align': STYLE_ALIGN,
    'vertical-align': [/^(?:top|middle|bottom|baseline)$/i],
    'font-size': STYLE_SIZE,
    'font-weight': [/^(?:\d{1,3}|normal|bold|bolder|lighter)$/i],
    'font-style': [/^(?:normal|italic|oblique)$/i],
    'font-family': [/^[a-z0-9\s,"'_\-]+$/i],
    'line-height': STYLE_SIZE,
    'letter-spacing': STYLE_SIZE,
    width: STYLE_SIZE,
    height: STYLE_SIZE,
    'max-width': STYLE_SIZE,
    'min-width': STYLE_SIZE,
    margin: [/^[-\d.\s%pxemrempt]+$/i],
    'margin-top': STYLE_SIZE,
    'margin-right': STYLE_SIZE,
    'margin-bottom': STYLE_SIZE,
    'margin-left': STYLE_SIZE,
    padding: [/^[-\d.\s%pxemrempt]+$/i],
    'padding-top': STYLE_SIZE,
    'padding-right': STYLE_SIZE,
    'padding-bottom': STYLE_SIZE,
    'padding-left': STYLE_SIZE,
    border: [/^[-\d.\s%pxemrempta-z#(),]+$/i],
    'border-width': STYLE_SIZE,
    'border-style': [/^(?:none|solid|dashed|dotted|double)$/i],
    'border-color': STYLE_COLOR,
    'border-collapse': [/^(?:collapse|separate)$/i],
    'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+(?:none|underline|line-through|overline))*$/i],
    'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
    display: STYLE_DISPLAY,
    float: [/^(?:none|left|right)$/i],
    clear: [/^(?:none|left|right|both)$/i],
    opacity: [/^(?:0|1|0?\.\d+)$/],
  },
};

/** 去掉 style 中的 url()/expression/behavior（防 CSS 外泄与 IE 脚本） */
export function scrubStyleAttr(style) {
  const s = String(style || '').trim();
  if (!s) return '';
  if (/expression\s*\(|url\s*\(|-moz-binding|behavior\s*:|@import/i.test(s)) return '';
  return s.slice(0, 4000);
}

/** 读信侧服务端消毒：去掉脚本/表单/危险 URL，保留常见邮件排版（图/表/字体） */
const MAIL_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
    'caption',
    'colgroup',
    'col',
    'span',
    'div',
    'font',
    'center',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'pre',
    'code',
    'blockquote',
    'ul',
    'ol',
    'li',
    'br',
    'p',
    'a',
    'b',
    'i',
    'u',
    'em',
    'strong',
    'small',
    'sub',
    'sup',
  ]),
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title', 'data-zm-tracked', 'data-zm-mismatch'],
    img: ['src', 'alt', 'title', 'width', 'height', 'border', 'align', 'hspace', 'vspace', 'style', 'class'],
    td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'background', 'style', 'class'],
    th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'background', 'style', 'class'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'background', 'style', 'class', 'bordercolor'],
    tr: ['align', 'valign', 'bgcolor', 'style', 'class'],
    caption: ['align', 'style', 'class'],
    col: ['width', 'span', 'align', 'valign'],
    colgroup: ['span', 'width', 'align', 'valign'],
    '*': ['style', 'class', 'align', 'color', 'bgcolor', 'width', 'height', 'dir', 'title'],
    font: ['color', 'size', 'face'],
  },
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'cid', 'data'],
    a: ['http', 'https', 'mailto', 'tel'],
  },
  /** background 属性也走 scheme 校验（表格背景图常见） */
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'action', 'formaction', 'background'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const next = enrichAnchorAttribs(attribs);
      if (next.style != null) {
        const scrubbed = scrubStyleAttr(next.style);
        if (scrubbed) next.style = scrubbed;
        else delete next.style;
      }
      return { tagName, attribs: next };
    },
    '*': (tagName, attribs) => {
      if (attribs.style != null) {
        const scrubbed = scrubStyleAttr(attribs.style);
        if (scrubbed) attribs.style = scrubbed;
        else delete attribs.style;
      }
      return { tagName, attribs };
    },
  },
  exclusiveFilter(frame) {
    // 拒绝 SVG / HTML data URI（防 XSS）；仅允许常见位图 data:image/*
    if (frame.tag === 'img' && frame.attribs?.src) {
      const src = String(frame.attribs.src);
      if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src)) {
        return true;
      }
    }
    if (frame.attribs?.background && /^data:/i.test(String(frame.attribs.background))) {
      const bg = String(frame.attribs.background);
      if (!/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(bg)) return true;
    }
    return false;
  },
};

export function sanitizeMailHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), MAIL_OPTIONS);
}
