import { sanitizeMailHtml } from '../server/sanitize_mail.js';

const tiny =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const html = `<p>Alice</p><img src="${tiny}" alt="logo" style="max-width:240px">`;
const out = sanitizeMailHtml(html);
console.log('keep data image:', out.includes('data:image/png'));
console.log('out:', out);

const big = 'data:image/jpeg;base64,' + 'A'.repeat(120_000);
const out2 = sanitizeMailHtml(`<img src="${big}">`);
console.log('keep big data:', out2.includes('data:image/jpeg'), 'len', out2.length);
