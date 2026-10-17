/**
 * 无依赖真实邮箱的纯逻辑单测。运行：npm test
 */
import { classify, expectsReply, signalsOf } from '../server/classify.js';
import { slaFor, slaByTier, domainOf, isFreeDomain, normalizeKey, scoreRow, tierOf } from '../server/priority.js';
import { matchCondition, matchRule } from '../server/mail_rules.js';
import { scopeFromAddress, isValidStage, stageMeta, STAGES, suggestStageAfterSend } from '../server/deals.js';
import { isBlockedHostname } from '../server/net_guard.js';
import { sanitizeMailHtml } from '../server/sanitize_mail.js';
import { assertPasswordStrength } from '../server/users.js';
import { STAGE_TO_LABEL } from '../server/labels.js';
import { generateSecret, generateSync, verifySync } from 'otplib';

let fail = 0;
let pass = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`OK  ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------- classify / expectsReply ----------
const replyCases = [
  ['Thanks', 'Thanks!', false],
  ['Re: PO', 'Thank you, well received.', false],
  ['FYI', 'FYI please see attached.', false],
  ['通知', '仅供参考', false],
  ['Hi', 'OK', false],
  ['收到', '收到，谢谢！', false],
  ['Update', 'No need to reply, just an update.', false],
  ['Quotation for cotton', 'Please find our quote for MOQ 500.', true],
  ['Sample request', 'Could you send lab dips?', true],
  ['PO#123', 'Please confirm the order.', true],
  ['Re: price', 'Looking forward to your reply.', true],
  ['询盘', '请报价 FOB Shanghai', true],
  ['Hello', 'What is your best price for SKU-1?', true],
];
for (const [subj, snip, want] of replyCases) {
  assert(`expectsReply ${JSON.stringify(subj)}`, expectsReply(subj, snip) === want, `got ${expectsReply(subj, snip)}`);
}

assert('signals inquiry', signalsOf('RFQ for jackets', 'Please quote FOB').includes('inquiry'));
assert('signals sample', signalsOf('Sample', 'Need lab dips').includes('sample'));
assert('signals urgent', signalsOf('URGENT', 'ASAP please').includes('urgent'));
assert('classify newsletter list', classify({ from: { address: 'news@brand.com' }, headers: { 'list-id': '<x>' }, subject: 'Weekly' }) === 'newsletter');
assert('classify noreply', classify({ from: { address: 'noreply@shop.com' }, subject: 'Order shipped' }) === 'notification');
assert('classify people', classify({ from: { address: 'buyer@acme-apparel.com' }, subject: 'Hello' }) === 'people');

// ---------- SLA ----------
assert('sla vip tighter', slaFor({ replySlaHours: 24, slaVipHours: 4 }, 'vip') === 4);
assert('sla new inquiry', slaFor({ replySlaHours: 24, slaNewInquiryHours: 8 }, 'new', ['inquiry']) === 8);
assert('sla customer default', slaFor({ replySlaHours: 24 }, 'customer') === 24);
const tiers = slaByTier({ replySlaHours: 24, slaVipHours: 2 });
assert('slaByTier vip', tiers.vip === 2);

// ---------- domain helpers ----------
assert('domainOf', domainOf('A@Acme.com') === 'acme.com');
assert('free gmail', isFreeDomain('gmail.com'));
assert('corp not free', !isFreeDomain('acme-apparel.com'));
assert('normalize email', normalizeKey('Buyer@Acme.com') === 'buyer@acme.com');
assert('normalize domain', normalizeKey('acme.com') === '@acme.com');
assert('normalize junk', normalizeKey('not an email') === '');

// ---------- tier / score (pure idx) ----------
const idx = {
  own: new Set(['me@zito.test']),
  ownDomains: new Set(['zito.test']),
  wrote: new Map([['buyer@acme.com', 3]]),
  wroteDomains: new Map([['acme.com', 5]]),
  rules: new Map([['@vipco.com', { key: '@vipco.com', kind: 'vip', name: 'VIP Co' }]]),
};
assert('tier vip rule', tierOf(idx, 'a@vipco.com') === 'vip');
assert('tier customer wrote', tierOf(idx, 'buyer@acme.com') === 'customer');
assert('tier colleague', tierOf(idx, 'other@zito.test') === 'colleague');
assert('tier new', tierOf(idx, 'stranger@newbrand.io', 'people') === 'new');
assert('tier self', tierOf(idx, 'me@zito.test') === 'self');

const scored = scoreRow(
  idx,
  {
    from_addr: 'buyer@acme.com',
    category: 'people',
    subject: 'Urgent PO confirm',
    snippet: 'Please confirm order ASAP',
    signals: 'urgent,order',
    date: Date.now() - 5 * 3600_000,
    to_json: JSON.stringify([{ address: 'me@zito.test' }]),
    flagged: 0,
    has_att: 0,
    seen: 0,
  },
  { slaHours: 4, at: Date.now() }
);
assert('score overdue vip-ish customer', scored.overdue === true && scored.score >= 50, JSON.stringify(scored));
assert('score why has tier', /老客户|VIP/.test(scored.why), scored.why);
assert('score why has overdue', scored.why.includes('已超时未回'), scored.why);
assert('score why has sla', scored.why.includes('时限'), scored.why);

const fresh = scoreRow(
  idx,
  {
    from_addr: 'buyer@acme.com',
    category: 'people',
    subject: 'Hello',
    snippet: 'Just saying hi',
    signals: '',
    date: Date.now() - 2 * 3600_000,
    to_json: JSON.stringify([{ address: 'me@zito.test' }]),
    flagged: 0,
    has_att: 0,
    seen: 1,
  },
  { slaHours: 24, at: Date.now() }
);
assert('score why waiting hours', fresh.why.includes('已等') && !fresh.why.includes('已超时未回'), fresh.why);
assert('score why not overdue under sla', fresh.overdue === false);

// ---------- mail rules match ----------
const ctx = {
  fromAddr: 'buyer@acme-apparel.com',
  fromName: 'Jane Buyer',
  subject: 'Quotation request for SS27',
  snippet: 'Please quote MOQ 500',
  hasAtt: true,
  category: 'people',
  mailboxId: 'mb1',
  myEmails: ['me@zito.test'],
  to: [{ address: 'me@zito.test' }],
  cc: [],
};
assert('rule from domain', matchCondition({ field: 'from', op: 'domain', value: '@acme-apparel.com' }, ctx));
assert('rule from is', matchCondition({ field: 'from', op: 'is', value: 'buyer@acme-apparel.com' }, ctx));
assert('rule subject contains', matchCondition({ field: 'subject', op: 'contains', value: 'quotation' }, ctx));
assert('rule has_att', matchCondition({ field: 'has_att', op: 'is', value: true }, ctx));
assert('rule to_me', matchCondition({ field: 'to_me', op: 'is', value: true }, ctx));
assert('rule keyword', matchCondition({ field: 'keyword', op: 'contains', value: 'MOQ' }, ctx));
assert(
  'rule all match',
  !!matchRule(
    {
      conditions: [
        { field: 'from', op: 'domain', value: '@acme-apparel.com' },
        { field: 'subject', op: 'contains', value: 'Quotation' },
      ],
    },
    ctx
  )
);
assert(
  'rule miss subject',
  matchRule({ conditions: [{ field: 'subject', op: 'contains', value: 'invoice-xyz' }] }, ctx) === null
);

// ---------- deals scope / stages ----------
assert('scope company', scopeFromAddress('buyer@acme-apparel.com')?.key === 'c:@acme-apparel.com');
assert('scope gmail personal', scopeFromAddress('buyer@gmail.com')?.key === 'a:buyer@gmail.com');
assert('scope robot null', scopeFromAddress('noreply@shop.com') == null);
assert('stages count', STAGES.length >= 6);
assert('valid stage inquiry', isValidStage('inquiry'));
assert('invalid stage', !isValidStage('foobar'));
assert('stageMeta quote', stageMeta('quote').label === '报价中');

// ---------- SSRF host guard ----------
assert('block localhost', isBlockedHostname('localhost'));
assert('block 127.0.0.1', isBlockedHostname('127.0.0.1'));
assert('block 10.x', isBlockedHostname('10.1.2.3'));
assert('block 192.168', isBlockedHostname('192.168.1.1'));
assert('block metadata link-local', isBlockedHostname('169.254.169.254'));
assert('allow public host name', !isBlockedHostname('imap.gmail.com'));
assert('allow public ip', !isBlockedHostname('8.8.8.8'));

// ---------- mail HTML sanitize ----------
assert('strip script', !sanitizeMailHtml('<p>Hi</p><script>alert(1)</script>').includes('script'));
assert('strip onerror', !/<img[^>]+onerror/i.test(sanitizeMailHtml('<img src=x onerror=alert(1)>')));
assert('keep mailto', sanitizeMailHtml('<a href="mailto:a@b.com">x</a>').includes('mailto:a@b.com'));
assert('block javascript href', !sanitizeMailHtml('<a href="javascript:alert(1)">x</a>').includes('javascript:'));

// ---------- password + totp ----------
assert('pwd too short fails', (() => { try { assertPasswordStrength('Ab1'); return false; } catch { return true; } })());
assert('pwd letters only fails', (() => { try { assertPasswordStrength('abcdefgh'); return false; } catch { return true; } })());
assert('pwd ok', (() => { try { assertPasswordStrength('Passw0rd!'); return true; } catch { return false; } })());
{
  const secret = generateSecret();
  const token = generateSync({ secret });
  assert('totp verifySync', !!verifySync({ token, secret })?.valid);
}
assert('stage map inquiry', STAGE_TO_LABEL.inquiry === '询盘');
assert('stage map quote', STAGE_TO_LABEL.quote === '报价中');
assert('stage map sample', STAGE_TO_LABEL.sample === '样品');
assert('stage map won', STAGE_TO_LABEL.won === '成交');
assert('suggest stage quote', suggestStageAfterSend('inquiry', 'Quotation for cotton tees', '')?.stage === 'quote');
assert('suggest stage sample', suggestStageAfterSend('quote', 'Sample shipment', '')?.stage === 'sample');
assert('suggest no regress', suggestStageAfterSend('payment', 'Re: inquiry', '') == null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
