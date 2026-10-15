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
/** 我方发出的邮件是否值得跟进（排除纯致谢、确认收到类） */
export function expectsReply(subject = '', snippet = '') {
  const s = String(snippet || '').trim();
  if (s.length < 90 && THANKS_ONLY.test(s)) return false;
  return true;
}
