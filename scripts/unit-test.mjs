/**
 * 无依赖真实邮箱的纯逻辑单测。运行：npm test
 */
import { classify, expectsReply, signalsOf } from '../server/classify.js';
import {
  slaFor,
  slaByTier,
  domainOf,
  isFreeDomain,
  normalizeKey,
  scoreRow,
  tierOf,
  buildFollowMeta,
  formatWaitingLabel,
  normalizeSubjectKey,
  suggestFollowAction,
  aggregateFollowupsByCustomer,
  followGroupKey,
} from '../server/priority.js';
import { matchCondition, matchRule } from '../server/mail_rules.js';
import {
  scopeFromAddress, resolveScopes, isValidStage, stageMeta, STAGES, suggestStageAfterSend,
  FOLLOW_SEQ_DAYS, quoteSnippet, scopeMailMatch,
} from '../server/deals.js';
import { APPAREL_EMAIL_TEMPLATES, ASSET_KIND_LABEL, FOLLOW_SEQ_DAYS as CLIENT_FOLLOW_SEQ } from '../web/src/apparelPresets.js';
import { isBlockedHostname, assertSafeAiBaseUrl, isLoopbackIp } from '../server/net_guard.js';
import { sanitizeMailHtml, scrubStyleAttr } from '../server/sanitize_mail.js';
import { assertPasswordStrength } from '../server/users.js';
import { STAGE_TO_LABEL } from '../server/labels.js';
import {
  conversationKey, ftsEscape, isSqliteCorrupt, reclaimStaleOutboxSending, claimOutboxSending,
} from '../server/repo.js';
import { threadIdOf, inlineCidImages, resolveCidPlaceholders, neutralizeOrphanCids, isAuthFailure, isTransientFailure, CID_DATA_MAX, MEDIA_BODY_VER } from '../server/imap.js';
import { queueScore } from '../server/team_queue.js';
import { status as oauthStatus } from '../server/oauth.js';
import { formatBizContext, normalizeTriageActions, triageContextLine } from '../server/ai_context.js';
import { isTransientSmtpError, loadOutboxFiles, OUTBOX_DIR } from '../server/mailer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aiModels, modelFor, routeForTask, scoreComplexity } from '../server/ai.js';
import { encrypt, decrypt, encryptBuffer, decryptBuffer } from '../server/security.js';
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
assert('signals fabric', signalsOf('Fabric', 'Need 180gsm cotton composition').includes('fabric'));
assert('signals fit', signalsOf('Fit comments', 'Size run S-XL too tight at waist').includes('fit'));
assert('signals tech pack as inquiry', signalsOf('Tech pack attached', 'Please review BOM').includes('inquiry'));
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

// ---------- 已发未回 follow meta（发出即可见 + soft/due）----------
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const atF = Date.now();
const soft = buildFollowMeta({
  date: atF - 2 * HOUR,
  at: atF,
  followDays: 3,
  tier: 'customer',
  to: { address: 'buyer@acme.com', name: 'Buyer' },
  signals: ['inquiry'],
});
assert('follow soft soon after send', soft.urgency === 'soft' && soft.due === false);
assert('follow waitingHours ~2h', soft.waitingHours >= 1.9 && soft.waitingHours <= 2.1);
assert('follow visible without followDays gate', soft.days === 0);

const due = buildFollowMeta({
  date: atF - 4 * DAY,
  at: atF,
  followDays: 3,
  tier: 'vip',
  to: { address: 'vip@acme.com' },
  signals: [],
});
assert('follow due after followDays', due.urgency === 'due' && due.due === true);
assert('follow due sorts above soft', due.score > soft.score);
assert('formatWaitingLabel hours', formatWaitingLabel(5, 0).includes('小时'));
assert('formatWaitingLabel days', /天/.test(formatWaitingLabel(50, 2)));
assert('normalizeSubjectKey strips Re', normalizeSubjectKey('Re: Quote for PO') === 'quote for po');
assert('suggest wait when soft fresh', suggestFollowAction({ urgency: 'soft', due: false, waitingHours: 2 }).code === 'wait');
assert('suggest escalate vip due', suggestFollowAction({ urgency: 'due', due: true, waitingHours: 30, tier: 'vip' }).code === 'escalate');
const agg = aggregateFollowupsByCustomer([
  {
    id: 1,
    date: atF - DAY,
    follow: buildFollowMeta({
      date: atF - DAY,
      at: atF,
      followDays: 3,
      tier: 'customer',
      to: { address: 'a@acme.com' },
      company: { key: '@acme.com', name: 'Acme' },
      signals: [],
    }),
  },
  {
    id: 2,
    date: atF - HOUR,
    follow: buildFollowMeta({
      date: atF - HOUR,
      at: atF,
      followDays: 3,
      tier: 'customer',
      to: { address: 'b@acme.com' },
      company: { key: '@acme.com', name: 'Acme' },
      signals: ['inquiry'],
    }),
  },
]);
assert('aggregate same company', agg.length === 1 && agg[0].follow.siblingCount === 2);
assert('aggregate keeps newer', agg[0].id === 2);
assert('followGroupKey company', followGroupKey({ key: '@Acme.com' }, { address: 'x@y.com' }) === '@acme.com');

// ---------- 客户时间线决策 ----------
import { computeDecision } from '../server/customer_timeline.js';
const mailsWait = [
  { id: 1, direction: 'out', date: atF - 5 * HOUR, fromAddr: 'me@zito.com' },
  { id: 2, direction: 'in', date: atF - 2 * DAY, fromAddr: 'buyer@acme.com' },
];
const decWait = computeDecision(1, 'buyer@acme.com', mailsWait, null);
assert('timeline waiting_them', decWait.status === 'waiting_them');
assert('timeline waiting hours', decWait.waitingHours >= 4);
const mailsReply = [
  { id: 3, direction: 'in', date: atF - 3 * HOUR, fromAddr: 'buyer@acme.com' },
  { id: 4, direction: 'out', date: atF - DAY, fromAddr: 'me@zito.com' },
];
const decReply = computeDecision(1, 'buyer@acme.com', mailsReply, null);
assert('timeline need_reply', decReply.status === 'need_reply');

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
assert('score hits array', Array.isArray(scored.hits) && scored.hits.length >= 3, JSON.stringify(scored.hits));
assert(
  'score hits codes',
  scored.hits.some((h) => h.code === 'overdue') && scored.hits.some((h) => String(h.code).startsWith('tier_')),
  JSON.stringify(scored.hits)
);

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
assert(
  'scopeMailMatch person a:',
  scopeMailMatch('a:buyer@acme.com')?.kind === 'address'
    && scopeMailMatch('a:buyer@acme.com')?.value === 'buyer@acme.com'
);
assert(
  'scopeMailMatch legacy p:',
  scopeMailMatch('p:buyer@acme.com')?.kind === 'address'
    && scopeMailMatch('p:buyer@acme.com')?.value === 'buyer@acme.com'
);
assert(
  'scopeMailMatch company c:@domain',
  scopeMailMatch('c:@acme-apparel.com')?.kind === 'domain'
    && scopeMailMatch('c:@acme-apparel.com')?.value === 'acme-apparel.com'
    && scopeMailMatch('c:@acme-apparel.com')?.like === '%@acme-apparel.com'
);
assert(
  'scopeMailMatch no double at',
  scopeMailMatch('c:@acme.com')?.like === '%@acme.com'
);
assert('scope robot null', scopeFromAddress('noreply@shop.com') == null);
assert(
  'scope person override',
  scopeFromAddress('buyer@acme-apparel.com', 'address')?.key === 'a:buyer@acme-apparel.com'
);
assert(
  'scope company explicit',
  scopeFromAddress('buyer@acme-apparel.com', 'company')?.key === 'c:@acme-apparel.com'
);
{
  const rs = resolveScopes('buyer2@acme-apparel.com');
  assert('resolveScopes has company', rs?.company?.key === 'c:@acme-apparel.com');
  assert('resolveScopes has person', rs?.person?.key === 'a:buyer2@acme-apparel.com');
  assert('resolveScopes default company', rs?.default?.kind === 'company');
}
assert('stages count', STAGES.length >= 6);
assert('valid stage inquiry', isValidStage('inquiry'));
assert('invalid stage', !isValidStage('foobar'));
assert('stageMeta quote', stageMeta('quote').label === '报价中');

// ---------- SSRF host guard ----------
assert('loopback 127', isLoopbackIp('127.0.0.1'));
assert('loopback ::1', isLoopbackIp('::1'));
assert('loopback mapped', isLoopbackIp('::ffff:127.0.0.1'));
assert('not loopback lan', !isLoopbackIp('192.168.1.8'));
assert('block localhost', isBlockedHostname('localhost'));
assert('block 127.0.0.1', isBlockedHostname('127.0.0.1'));
assert('block 10.x', isBlockedHostname('10.1.2.3'));
assert('block 192.168', isBlockedHostname('192.168.1.1'));
assert('block metadata link-local', isBlockedHostname('169.254.169.254'));
assert('block ipv4-mapped private', isBlockedHostname('::ffff:10.1.2.3'));
assert('block ipv4-mapped loopback', isBlockedHostname('::ffff:127.0.0.1'));
assert('allow ipv4-mapped public', !isBlockedHostname('::ffff:8.8.8.8'));
assert('allow public host name', !isBlockedHostname('imap.gmail.com'));
assert('allow public ip', !isBlockedHostname('8.8.8.8'));

// ---------- mail HTML sanitize ----------
assert('strip script', !sanitizeMailHtml('<p>Hi</p><script>alert(1)</script>').includes('script'));
assert('strip onerror', !/<img[^>]+onerror/i.test(sanitizeMailHtml('<img src=x onerror=alert(1)>')));
assert('keep mailto', sanitizeMailHtml('<a href="mailto:a@b.com">x</a>').includes('mailto:a@b.com'));
assert('block javascript href', !sanitizeMailHtml('<a href="javascript:alert(1)">x</a>').includes('javascript:'));
assert(
  'keep data image in signature',
  sanitizeMailHtml('<p>Alice</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="logo">').includes('data:image/png')
);
assert('block data:text scheme', !sanitizeMailHtml('<a href="data:text/html,hi">x</a>').includes('data:text'));
assert(
  'block data html img',
  !sanitizeMailHtml('<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">').includes('data:text/html')
);
assert(
  'block svg data img',
  !sanitizeMailHtml('<img src="data:image/svg+xml;base64,PHN2Zy8+">').includes('svg+xml')
);
assert('scrub style url()', scrubStyleAttr('color:red;background:url(https://evil.test/x)') === '');
assert('scrub style expression', scrubStyleAttr('width:expression(alert(1))') === '');
assert('keep safe style color', /color:\s*red/i.test(sanitizeMailHtml('<p style="color:red">x</p>')));
assert(
  'strip style url in html',
  !/url\(/i.test(sanitizeMailHtml('<p style="background:url(https://evil.test/t.png)">x</p>'))
);

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
assert('suggest stage pp sample', suggestStageAfterSend('quote', 'PP sample for approval', '')?.stage === 'sample');
assert('suggest stage tech pack inquiry', suggestStageAfterSend(null, 'Please send tech pack', '')?.stage === 'inquiry');
assert('suggest no regress', suggestStageAfterSend('payment', 'Re: inquiry', '') == null);

assert('FOLLOW_SEQ quote +3', FOLLOW_SEQ_DAYS.quote === 3);
assert('FOLLOW_SEQ sample +7', FOLLOW_SEQ_DAYS.sample === 7);
assert('FOLLOW_SEQ bulk +5', FOLLOW_SEQ_DAYS.bulk === 5);
assert('FOLLOW_SEQ client aligned', CLIENT_FOLLOW_SEQ.quote === FOLLOW_SEQ_DAYS.quote && CLIENT_FOLLOW_SEQ.sample === FOLLOW_SEQ_DAYS.sample);
// ---------- desktop_boot（子进程，避免污染当前进程 env） ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zito-desk-'));
  const env = { ...process.env, ZITO_DESKTOP: '1', ZITO_HOME: home, NODE_ENV: 'production' };
  delete env.MAIL_SECRET;
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';
       import { applyDesktopEnv, readDesktopConfig, IS_DESKTOP, desktopConfigPath } from './server/desktop_boot.js';
       const info = applyDesktopEnv();
       const cfg = readDesktopConfig();
       if (!IS_DESKTOP) { console.log('FAIL not desktop'); process.exit(2); }
       if (!info.applied || !cfg.mailSecret || cfg.mailSecret.length < 32) { console.log('FAIL secret'); process.exit(3); }
       if (!process.env.DATA_DIR.includes('data')) { console.log('FAIL data'); process.exit(4); }
       const disk = JSON.parse(fs.readFileSync(desktopConfigPath(), 'utf8'));
       if (!String(disk.mailSecret || '').startsWith('d1.')) { console.log('FAIL not sealed'); process.exit(5); }
       console.log('OK');`,
    ],
    {
      cwd: path.resolve('.'),
      env,
      encoding: 'utf8',
    }
  );
  assert('desktop_boot generates MAIL_SECRET', (r.stdout || '').includes('OK'), r.stderr || r.stdout || `code=${r.status}`);
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (_) {}
}

assert('quoteSnippet empty deal', quoteSnippet(null) === '' && quoteSnippet({}) === '');
assert(
  'quoteSnippet commerce',
  quoteSnippet({ styleNo: 'ZS-01', currency: 'USD', amount: 12.5, moq: '500', leadDays: 45, incoterm: 'FOB' }).includes('Style: ZS-01')
    && quoteSnippet({ styleNo: 'ZS-01', currency: 'USD', amount: 12.5, moq: '500', leadDays: 45, incoterm: 'FOB' }).includes('FOB')
);
assert(
  'quoteSnippet multi styles',
  quoteSnippet({ amount: 9 }, { styles: [{ styleNo: 'A1', colorway: 'Navy' }, { styleNo: 'B2' }] }).includes('Style: A1 / Navy')
    && quoteSnippet({ amount: 9 }, { styles: [{ styleNo: 'A1', colorway: 'Navy' }, { styleNo: 'B2' }] }).includes('Style: B2')
);
assert(
  'quoteSnippet style price moq',
  quoteSnippet(
    { currency: 'USD', amount: 100 },
    { styles: [{ styleNo: 'ZS-9', colorway: 'Black', unitPrice: 3.2, moq: '500', currency: 'USD' }] }
  ).includes('USD 3.2')
    && quoteSnippet(
      { currency: 'USD', amount: 100 },
      { styles: [{ styleNo: 'ZS-9', colorway: 'Black', unitPrice: 3.2, moq: '500', currency: 'USD' }] }
    ).includes('MOQ 500')
);
assert(
  'formatBizContext commerce',
  formatBizContext({
    stageLabel: '报价中',
    dealMine: true,
    styleLines: ['ZS-1 / Navy / USD 4'],
    amount: 12,
    currency: 'USD',
    moq: '300',
    stageHint: 'x',
  }).includes('款号报价：ZS-1 / Navy / USD 4')
    && formatBizContext({
      stageLabel: '报价中',
      dealMine: true,
      styleLines: ['ZS-1 / Navy / USD 4'],
      amount: 12,
      currency: 'USD',
      moq: '300',
      stageHint: 'x',
    }).includes('成交要点：USD 12 · MOQ 300')
);
assert(
  'formatBizContext brand sample follow',
  (() => {
    const block = formatBizContext({
      stageLabel: '样品',
      dealMine: true,
      brandName: 'Elevia',
      styleLines: ['ZS-2 / S-XL'],
      sampleLines: ['SMS · shipped · SF123'],
      nextFollowAt: Date.UTC(2026, 5, 15),
      dealNote: '等 PP 意见',
      stageHint: 'x',
    });
    return (
      block.includes('品牌：Elevia')
      && block.includes('样品：SMS · shipped · SF123')
      && block.includes('下次跟进：')
      && block.includes('成交备注：等 PP 意见')
    );
  })()
);
assert('smtp transient timeout', isTransientSmtpError('ETIMEDOUT connecting'));
assert('smtp transient 421', isTransientSmtpError('421 Try again later'));
assert('smtp auth not transient', !isTransientSmtpError('535 Authentication failed'));
assert('outbox load rejects outside dir', loadOutboxFiles(path.join(os.tmpdir(), 'not-outbox-xyz')).length === 0);
assert('outbox dir constant set', typeof OUTBOX_DIR === 'string' && OUTBOX_DIR.length > 0);
assert('reclaimStaleOutboxSending export', typeof reclaimStaleOutboxSending === 'function');
assert('claimOutboxSending export', typeof claimOutboxSending === 'function');
assert('ASSET_KIND techpack label', ASSET_KIND_LABEL.techpack === 'Tech pack');
assert('apparel template has stage', APPAREL_EMAIL_TEMPLATES.some((t) => t.stage === 'quote'));
assert('FOLLOW_SEQ force days sample', FOLLOW_SEQ_DAYS.sample === 7 && FOLLOW_SEQ_DAYS.bulk === 5);

// ---------- conversationKey ----------
assert('conv key prefers thread', conversationKey({ thread_id: 't1', in_reply_to: 'p1', message_id: 'm1', id: 9 }) === 't1');
assert('conv key falls to in_reply_to', conversationKey({ thread_id: null, in_reply_to: 'p1', message_id: 'm1' }) === 'p1');
assert('conv key falls to message_id', conversationKey({ message_id: 'm1', id: 3 }) === 'm1');
assert('conv key id fallback', conversationKey({ id: 42 }) === '#42');

assert('threadIdOf prefers first References', threadIdOf('<m3>', '<m2>', '<m1> <m2>') === 'm1');
assert('threadIdOf falls to In-Reply-To', threadIdOf('<m3>', '<m2>', '') === 'm2');
assert('threadIdOf falls to self', threadIdOf('<m3>', '', '') === 'm3');

assert('queueScore vip+overdue high', queueScore({ vip: true, overdue: true, waitingHours: 30, signals: ['inquiry'] }) >= 150);
assert('queueScore plain lower', queueScore({ vip: false, overdue: false, waitingHours: 2, signals: [] }) < 50);
assert('oauth status shape', typeof oauthStatus().ready === 'boolean' && Array.isArray(oauthStatus().missing));

// ---------- AI biz context / triage actions ----------
{
  const biz = {
    stageLabel: '报价中',
    stage: 'quote',
    dealMine: true,
    dealOwner: '我',
    unclaimed: false,
    tierLabel: '老客户',
    waitingHours: 10,
    slaHours: 8,
    overdue: true,
    signalLabels: ['询盘', '紧急'],
    stageHint: '围绕报价审阅回复',
  };
  const block = formatBizContext(biz);
  assert('formatBizContext has stage', block.includes('业务阶段：报价中'));
  assert('formatBizContext overdue', block.includes('已超时'));
  assert('formatBizContext guard', block.includes('勿编造'));
  assert('triageContextLine compact', triageContextLine(biz).includes('阶段=报价中') && triageContextLine(biz).includes('已超时'));

  const acts = normalizeTriageActions(
    [
      { type: 'claim', label: '认领' },
      { type: 'stage', stage: 'quote', label: '再报价' },
      { type: 'stage', stage: 'sample', label: '推进样品' },
      { type: 'reply', label: '写回复', instruction: '确认交期' },
      { type: 'snooze', hours: 100, label: '太久' },
      { type: 'hack', label: '坏' },
    ],
    biz
  );
  assert('normalize drops claim when mine', !acts.some((a) => a.type === 'claim'));
  assert('normalize drops same stage', !acts.some((a) => a.type === 'stage' && a.stage === 'quote'));
  assert('normalize keeps sample stage', acts.some((a) => a.type === 'stage' && a.stage === 'sample'));
  assert('normalize caps snooze hours', acts.find((a) => a.type === 'snooze')?.hours === 72);
  assert('normalize max 3', acts.length <= 3);

  const unclaimed = normalizeTriageActions([{ type: 'reply', label: '回' }], {
    unclaimed: true,
    dealMine: false,
    dealOwner: null,
  });
  assert('normalize injects claim when unclaimed', unclaimed[0]?.type === 'claim');
}
{
  const prev = {
    AI_MODEL: process.env.AI_MODEL,
    AI_MODEL_FAST: process.env.AI_MODEL_FAST,
    AI_MODEL_MID: process.env.AI_MODEL_MID,
    AI_MODEL_STRONG: process.env.AI_MODEL_STRONG,
  };
  process.env.AI_MODEL = 'qwen3.8-max';
  delete process.env.AI_MODEL_FAST;
  delete process.env.AI_MODEL_MID;
  delete process.env.AI_MODEL_STRONG;
  const defaults = aiModels();
  assert('model default strong', defaults.strong === 'qwen3.8-max' && modelFor('strong') === 'qwen3.8-max');
  assert('model default fast flash', defaults.fast === 'qwen3.6-flash');
  assert('model default mid deepseek', defaults.mid === 'deepseek-v4.1-flash');
  process.env.AI_MODEL_FAST = 'qwen3.6-flash';
  process.env.AI_MODEL_MID = 'deepseek-v4.1-flash';
  process.env.AI_MODEL_STRONG = 'qwen3.8-max';
  const m = aiModels();
  assert('model fast tier', m.fast === 'qwen3.6-flash' && modelFor('fast') === 'qwen3.6-flash');
  assert('model strong tier', m.strong === 'qwen3.8-max' && modelFor('strong') === 'qwen3.8-max');
  assert('complexity easy low', scoreComplexity({ subject: 'Hi', text: 'Thanks' }) < 30);
  assert('complexity hard high', scoreComplexity({ subject: 'Complaint', text: 'quality claim and LC dispute' }) >= 35);
  assert('route triage fast', routeForTask('triage', {}).tier === 'fast' && routeForTask('triage', {}).enableThinking === false);
  const hardReply = routeForTask('reply', { subject: 'Payment overdue', text: 'Please settle deposit and PI urgently' });
  assert('route hard reply thinks', hardReply.tier === 'strong' && hardReply.enableThinking === true);
  const easyReply = routeForTask('reply', { subject: 'Thanks', text: 'Got it' });
  assert('route easy reply no think', easyReply.tier === 'strong' && easyReply.enableThinking === false);
  for (const [k, v] of Object.entries(prev)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------- crypto / backup blob ----------
{
  const round = decrypt(encrypt('imap-app-password-测试'));
  assert('encrypt v2 roundtrip', round === 'imap-app-password-测试');
  assert('encrypt has v2 prefix', encrypt('x').startsWith('v2.'));
  const blob = encryptBuffer(Buffer.from('sqlite-bytes'));
  assert('backup magic ZMB1', blob.subarray(0, 4).toString() === 'ZMB1');
  assert('backup decrypt', decryptBuffer(blob).toString() === 'sqlite-bytes');
}

// ---------- cid inline (Content-ID 带 <> vs cid: 无 <>) ----------
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const html = inlineCidImages('<img src="cid:pic@mail">', [
    { contentId: '<pic@mail>', contentType: 'image/png', size: png.length, content: png },
  ]);
  assert('cid matches angle-bracket Content-ID', html.includes('data:image/png;base64,'));
  const caseHtml = inlineCidImages('<img src="cid:Pic@Mail">', [
    { contentId: '<pic@mail>', contentType: 'image/png', size: png.length, content: png },
  ]);
  assert('cid match case-insensitive', caseHtml.includes('data:image/png;base64,'));
  const unquoted = inlineCidImages('<img src=cid:pic@mail>', [
    { contentId: '<pic@mail>', contentType: 'image/png', size: png.length, content: png },
  ]);
  assert('cid unquoted src=', unquoted.includes('data:image/png;base64,'));
  const byName = inlineCidImages('<img src="cid:product.png@01D">', [
    { contentId: '', filename: 'product.png', contentType: 'image/png', size: png.length, content: png },
  ]);
  assert('cid fallback filename', byName.includes('data:image/png;base64,'));
  assert('CID_DATA_MAX is small', CID_DATA_MAX <= 64 * 1024);
  assert('MEDIA_BODY_VER >= 3', MEDIA_BODY_VER >= 3);
  const mid = { contentId: 'mid@x', contentType: 'image/jpeg', size: CID_DATA_MAX + 1, content: Buffer.alloc(10) };
  const midPh = inlineCidImages('url(cid:mid@x)', [mid]);
  assert('product-size cid becomes placeholder', midPh.includes('__ZM_CID_0__'));
  const big = { contentId: 'big@x', contentType: 'image/jpeg', size: 900_000, content: Buffer.alloc(10) };
  const ph = inlineCidImages('url(cid:big@x)', [big]);
  assert('large cid becomes placeholder', ph.includes('__ZM_CID_0__'));
  const resolved = resolveCidPlaceholders(ph, 42, [big]);
  assert('placeholder → attachment url', resolved.includes('/api/messages/42/attachments/0?inline=1'));
  const orphan = neutralizeOrphanCids('<img src="cid:missing@x"><img src="cid:also@y">');
  assert('orphan cid neutralized', !/cid:/i.test(orphan.html) && orphan.replaced === 2);
  assert('sanitize keeps relative api img', sanitizeMailHtml('<img src="/api/messages/1/attachments/0?inline=1">').includes('/api/messages/1/attachments/0'));
  assert('sanitize keeps table background attr', /background=/i.test(sanitizeMailHtml('<td background="https://cdn.example/bg.png">x</td>')));
  assert('sanitize keeps caption', sanitizeMailHtml('<table><caption>报价表</caption><tr><td>1</td></tr></table>').includes('报价表'));
}

assert('isAuthFailure login', isAuthFailure({ authenticationFailed: true }));
assert('isTransient timeout', isTransientFailure({ message: 'Connection timed out' }));
assert('auth not transient', !isTransientFailure({ authenticationFailed: true, message: 'auth' }));

assert('isSqliteCorrupt malformed', isSqliteCorrupt(new Error('database disk image is malformed')));
assert('isSqliteCorrupt SQLITE_CORRUPT', isSqliteCorrupt({ message: 'SQLITE_CORRUPT: database disk image is malformed' }));
assert('isSqliteCorrupt contentless', isSqliteCorrupt(new Error('cannot DELETE from contentless fts5 table: messages_fts')));
assert('isSqliteCorrupt legacy trigger cols', isSqliteCorrupt(new Error('table messages_fts has no column named from_name')));
assert('isSqliteCorrupt ignores other', !isSqliteCorrupt(new Error('UNIQUE constraint failed')));

// ---------- FTS5 CJK / 款号（unicode61 勿整词引号）----------
assert('ftsEscape CJK NEAR', ftsEscape('询盘报价') === '询 NEAR/1 盘 NEAR/1 报 NEAR/1 价');
assert('ftsEscape single CJK', ftsEscape('款') === '款');
assert('ftsEscape style code prefix', ftsEscape('ZS-2401') === '"ZS"* "2401"*');
assert('ftsEscape latin phrase', ftsEscape('cotton jersey') === '"cotton"* "jersey"*');
assert('ftsEscape mixed CJK+latin', ftsEscape('报价 PO123').includes('报 NEAR/1 价') && ftsEscape('报价 PO123').includes('"PO123"*'));
assert('ftsEscape strips input quotes', ftsEscape('ab"cd') === '"ab"* "cd"*');
assert('ftsEscape empty', ftsEscape('   ') === '');

{
  const { sealDesktopSecret, unsealDesktopSecret } = await import('../server/desktop_boot.js');
  const sealed = sealDesktopSecret('super-secret-token-xyz');
  assert('desk seal prefix', sealed.startsWith('d1.'));
  assert('desk unseal roundtrip', unsealDesktopSecret(sealed) === 'super-secret-token-xyz');
  assert('desk unseal plaintext passthrough', unsealDesktopSecret('plain-legacy') === 'plain-legacy');
  assert('desk seal idempotent', sealDesktopSecret(sealed) === sealed);
}

{
  const { putMessageCache, getMessageCache, clearMessageCache } = await import('../web/src/messageCache.js');
  clearMessageCache();
  putMessageCache(7, { id: 7, subject: 'hi', html: '<b>x</b>' });
  assert('messageCache hit', getMessageCache(7)?.subject === 'hi');
  assert('messageCache miss', getMessageCache(8) == null);
  clearMessageCache();
  assert('messageCache clear', getMessageCache(7) == null);
}

{
  let aiHttpRejected = false;
  try {
    await assertSafeAiBaseUrl('http://example.com/v1');
  } catch {
    aiHttpRejected = true;
  }
  assert('reject AI http base', aiHttpRejected);
  let aiLocalRejected = false;
  try {
    await assertSafeAiBaseUrl('https://127.0.0.1/v1');
  } catch {
    aiLocalRejected = true;
  }
  assert('reject AI loopback base', aiLocalRejected);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
