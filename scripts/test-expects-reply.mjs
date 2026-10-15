import { expectsReply, signalsOf } from '../server/classify.js';

const cases = [
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

let fail = 0;
for (const [subj, snip, want] of cases) {
  const got = expectsReply(subj, snip);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'OK' : 'FAIL'} ${JSON.stringify(subj)} / ${JSON.stringify(snip)} => ${got} (want ${want}) [${signalsOf(subj, snip)}]`);
}
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
