import sanitizeHtml from 'sanitize-html';

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
    a: ['href', 'name', 'target', 'rel', 'title'],
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
  allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'cid', 'data'],
    a: ['http', 'https', 'mailto'],
  },
  /** background 属性也走 scheme 校验（表格背景图常见） */
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'action', 'formaction', 'background'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

export function sanitizeMailHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), MAIL_OPTIONS);
}
