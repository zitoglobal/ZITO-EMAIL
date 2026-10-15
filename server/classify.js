const NOREPLY = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|notification|notifications|notify|alert|alerts|mailer-daemon|postmaster|system|service|support|account|security|billing|invoice|receipts?|info@|news@|newsletter)/i;
const NEWSLETTER_SENDERS = /(newsletter|news@|digest|marketing|promo|offers?@|deals?@|hello@|updates?@)/i;
const NOTIFY_SUBJECT = /(验证码|verification|verify|code|登录提醒|安全提醒|security alert|password|密码|订单|order|发货|shipped|delivery|invoice|发票|账单|receipt|payment|支付|通知|notification|reminder|提醒)/i;

/**
 * 智能收件箱分类：people 联系人 / notification 通知 / newsletter 订阅资讯
 */
export function classify({ from, headers = {}, subject = '' }) {
  const address = String(from?.address || '').toLowerCase();
  const hasListHeaders = !!(headers['list-unsubscribe'] || headers['list-id']);
  const bulk = /bulk|list|junk/i.test(headers.precedence || '');
  const auto = headers['auto-submitted'] && !/^no$/i.test(headers['auto-submitted']);

  if (hasListHeaders || bulk || NEWSLETTER_SENDERS.test(address)) {
    if (NOTIFY_SUBJECT.test(subject) && !NEWSLETTER_SENDERS.test(address)) return 'notification';
    return 'newsletter';
  }
  if (auto || NOREPLY.test(address)) return 'notification';
  return 'people';
}

/** 外贸业务意图识别（中英文），按重要程度排列 */
const SIGNALS = [
  ['urgent', /\b(urgent|asap|a\.s\.a\.p|immediately|rush|deadline|top priority)\b|as soon as possible|紧急|加急|尽快|马上|立即|立刻|截止/i],
  ['complaint', /\b(complain(t|ts)?|defect(s|ive)?|damaged|claim|refund|disappointed|unacceptable|wrong (size|color|colour|item))\b|quality (issue|problem)|not satisfied|投诉|质量问题|次品|瑕疵|色差|退货|退款|索赔|不满意/i],
  ['order', /\b(p\.?o\.?\s?#?\d+|purchase order|new order|repeat order|re-?order|bulk order|place (an |the |our )?order|order confirm(ation|ed)?|confirm(ed)? (the |our )?order)\b|下单|订单|返单|大货/i],
  ['payment', /\b(payment|remittance|swift|t\/t|tt copy|deposit|balance payment|proforma|p\.?i\.?|invoice|bank slip|wire transfer|l\/c)\b|付款|汇款|水单|定金|订金|尾款|形式发票|发票|信用证/i],
  ['inquiry', /\b(inquiry|enquiry|rfq|quotation|quote|price list|pricing|best price|fob|cif|exw|moq|catalog(ue)?|interested in)\b|询盘|询价|报价|价格|价目|起订量|目录/i],
  ['sample', /\b(samples?|swatch(es)?|lab ?dips?|proto(type)?|fit sample|pp sample|strike.?off)\b|打样|样品|样衣|色卡|面料卡|确认样/i],
  ['shipping', /\b(shipment|shipping|etd|eta|b\/l|bill of lading|container|vessel|tracking (no|number)|forwarder|customs|packing list)\b|出货|发货|船期|提单|货代|报关|物流|装箱单/i],
];

export function signalsOf(subject = '', snippet = '') {
  const text = `${subject}\n${snippet}`;
  const out = SIGNALS.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (/[?？]/.test(text)) out.push('question');
  return out;
}

const THANKS_ONLY = /^(hi|hello|dear)?[\s\S]{0,40}(thanks?|thank you|noted|well received|received with thanks|收到|谢谢|好的)[\s\S]{0,40}$/i;
const SHORT_ACK = /^(ok|okay|got it|noted|thanks?|thank you|收到|好的|嗯|谢谢|已知晓|了解)[\s.!！。]*$/i;
const FYI_ONLY = /^(fyi\b|for your (information|ref(erence)?)|仅供参考|请查收|通知[:：]?)/i;
const NO_REPLY_NEEDED = /\b(no (need to )?reply|do not reply|please do not reply|无需回复|不用回复|请勿回复)\b/i;
/** 仍值得跟进：报价/样品/等确认 */
const KEEP_FOLLOW = /\b(quot(e|ation)|price|sample|swatch|lab ?dip|confirm|confirmation|await(ing)?|looking forward|please (reply|confirm|advise|check|review)|kindly (confirm|advise|reply))\b|报价|样品|色卡|确认样|请确认|请回复|请惠复|等您|敬请|候复|盼复/i;
const KEEP_SIGNALS = new Set(['inquiry', 'sample', 'order', 'payment', 'question', 'urgent', 'complaint']);

/**
 * 我方发出的邮件是否值得跟进。
 * 收紧：排除纯致谢 / FYI / 明确无需回复；保留报价、样品、等确认、业务意图。
 */
export function expectsReply(subject = '', snippet = '') {
  const subj = String(subject || '').trim();
  const s = String(snippet || '').trim();
  const text = `${subj}\n${s}`;
  const sigs = signalsOf(subj, s);

  if (sigs.some((k) => KEEP_SIGNALS.has(k))) return true;
  if (KEEP_FOLLOW.test(text)) return true;

  if (NO_REPLY_NEEDED.test(text)) return false;
  if (FYI_ONLY.test(subj) || FYI_ONLY.test(s.slice(0, 100))) return false;
  if (s.length < 90 && THANKS_ONLY.test(s)) return false;
  if (s.length < 60 && SHORT_ACK.test(s)) return false;
  // 主题即致谢且正文很短
  if (s.length < 120 && THANKS_ONLY.test(subj) && !/[?？]/.test(text)) return false;

  return true;
}
