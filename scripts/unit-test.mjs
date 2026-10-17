/**
 * 无依赖真实邮箱的纯逻辑单测。运行：npm test
 */
import { classify, expectsReply, signalsOf } from '../server/classify.js';
import { slaFor, slaByTier, domainOf, isFreeDomain, normalizeKey, scoreRow, tierOf } from '../server/priority.js';
import { matchCondition, matchRule } from '../server/mail_rules.js';
import { scopeFromAddress, resolveScopes, isValidStage, stageMeta, STAGES, suggestStageAfterSend } from '../server/deals.js';
import { isBlockedHostname } from '../server/net_guard.js';
import { sanitizeMailHtml } from '../server/sanitize_mail.js';
import { assertPasswordStrength } from '../server/users.js';
import { STAGE_TO_LABEL } from '../server/labels.js';
import { conversationKey } from '../server/repo.js';
import { threadIdOf, inlineCidImages, resolveCidPlaceholders, isAuthFailure, isTransientFailure } from '../server/imap.js';
import { queueScore } from '../server/team_queue.js';
import { status as oauthStatus } from '../server/oauth.js';
import { formatBizContext, normalizeTriageActions, triageContextLine } from '../server/ai_context.js';
import { aiModels, modelFor } from '../server/ai.js';
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
  assert('model default cascade', modelFor('fast') === 'qwen3.8-max' && modelFor('strong') === 'qwen3.8-max');
  process.env.AI_MODEL_FAST = 'qwen-plus';
  process.env.AI_MODEL_MID = 'qwen-plus';
  process.env.AI_MODEL_STRONG = 'qwen3.8-max';
  const m = aiModels();
  assert('model fast tier', m.fast === 'qwen-plus' && modelFor('fast') === 'qwen-plus');
  assert('model strong tier', m.strong === 'qwen3.8-max' && modelFor('strong') === 'qwen3.8-max');
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
  const big = { contentId: 'big@x', contentType: 'image/jpeg', size: 900_000, content: Buffer.alloc(10) };
  const ph = inlineCidImages('url(cid:big@x)', [big]);
  assert('large cid becomes placeholder', ph.includes('__ZM_CID_0__'));
  const resolved = resolveCidPlaceholders(ph, 42, [big]);
  assert('placeholder → attachment url', resolved.includes('/api/messages/42/attachments/0?inline=1'));
  assert('sanitize keeps relative api img', sanitizeMailHtml('<img src="/api/messages/1/attachments/0?inline=1">').includes('/api/messages/1/attachments/0'));
}

assert('isAuthFailure login', isAuthFailure({ authenticationFailed: true }));
assert('isTransient timeout', isTransientFailure({ message: 'Connection timed out' }));
assert('auth not transient', !isTransientFailure({ authenticationFailed: true, message: 'auth' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
