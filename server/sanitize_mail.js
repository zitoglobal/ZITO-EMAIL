import sanitizeHtml from 'sanitize-html';

/** 读信侧服务端消毒：去掉脚本/表单/危险 URL，保留常见邮件排版 */
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
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
    th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'style'],
    tr: ['align', 'valign', 'bgcolor', 'style'],
    col: ['width', 'span'],
    colgroup: ['span', 'width'],
    '*': ['style', 'class', 'align', 'color', 'bgcolor', 'width', 'height', 'dir'],
    font: ['color', 'size', 'face'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'cid', 'data'],
    a: ['http', 'https', 'mailto'],
  },
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
