import { db, now } from './db.js';
import { MY_LAST_SQL, rowToMessage } from './repo.js';
import { expectsReply, signalsOf } from './classify.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const REPLY_WINDOW = 14 * DAY;
const FOLLOW_WINDOW = 21 * DAY;

/** 公共邮箱域名：不能按域名归并为同一家公司 */
const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.jp', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.ru', 'yandex.ru', 'yandex.com',
  'naver.com', 'hanmail.net', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com',
  '189.cn', 'tom.com', 'ethereal.email',
]);
const ROBOT = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?@|bounce)/i;

export const domainOf = (a) => String(a || '').toLowerCase().split('@')[1] || '';
export const isFreeDomain = (d) => FREE_DOMAINS.has(d);

const TIER_SCORE = { vip: 50, customer: 30, new: 12, colleague: 8, bulk: -40, muted: -80, self: -80 };
const SIGNAL_SCORE = { urgent: 22, complaint: 22, order: 20, payment: 18, inquiry: 14, sample: 10, shipping: 8, question: 6 };
const SIGNAL_LABEL = { urgent: '紧急', complaint: '投诉', order: '订单', payment: '付款', inquiry: '询盘', sample: '样品', shipping: '物流', question: '有提问' };
const TIER_LABEL = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事' };

// ---------- 发件人关系索引 ----------
const cache = new Map();
export const invalidate = (userId) => cache.delete(userId);

export function relationIndex(userId) {
  const hit = cache.get(userId);
  if (hit && now() - hit.at < 60_000) return hit.idx;
  const own = new Set(db.prepare('SELECT email FROM mailboxes WHERE user_id = ?').all(userId).map((r) => r.email.toLowerCase()));
  const ownDomains = new Set([...own].map(domainOf).filter((d) => d && !isFreeDomain(d)));
  const wrote = new Map();
  const wroteDomains = new Map();
  const rows = db
    .prepare(
      `SELECT m.to_json, m.cc_json FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ? AND m.from_addr = b.email AND IFNULL(f.special_use, '') NOT IN ('\\Drafts', '\\Trash')`
    )
    .all(userId);
  for (const r of rows) {
    for (const a of [...JSON.parse(r.to_json || '[]'), ...JSON.parse(r.cc_json || '[]')]) {
      const addr = String(a.address || '').toLowerCase();
      if (!addr || own.has(addr)) continue;
      wrote.set(addr, (wrote.get(addr) || 0) + 1);
      const d = domainOf(addr);
      if (d && !isFreeDomain(d)) wroteDomains.set(d, (wroteDomains.get(d) || 0) + 1);
    }
  }
  const rules = new Map(db.prepare('SELECT key, kind, name FROM sender_rules WHERE user_id = ?').all(userId).map((r) => [r.key.toLowerCase(), r]));
  const idx = { own, ownDomains, wrote, wroteDomains, rules };
  cache.set(userId, { at: now(), idx });
  return idx;
}

export function ruleFor(idx, address) {
  const a = String(address || '').toLowerCase();
  return idx.rules.get(a) || idx.rules.get('@' + domainOf(a)) || null;
}

export function tierOf(idx, address, category = 'people') {
  const a = String(address || '').toLowerCase();
  const d = domainOf(a);
  if (!a || idx.own.has(a)) return 'self';
  const rule = ruleFor(idx, a);
  if (rule?.kind === 'muted') return 'muted';
  if (rule?.kind === 'vip') return 'vip';
  if (category === 'newsletter' || ROBOT.test(a)) return 'bulk';
  if (idx.ownDomains.has(d)) return 'colleague';
  if (idx.wrote.has(a) || (!isFreeDomain(d) && idx.wroteDomains.has(d))) return 'customer';
  if (category === 'notification') return 'bulk';
  return 'new';
}

/** 客户归属：公司域名归为一组，公共邮箱按个人 */
export function companyOf(idx, from) {
  const a = String(from?.address || '').toLowerCase();
  const d = domainOf(a);
  const rule = ruleFor(idx, a);
  if (isFreeDomain(d) || !d) return { key: a, name: rule?.name || from?.name || a };
  const domainRule = idx.rules.get('@' + d);
  const base = d.replace(/^(mail|email|www)\./, '').split('.')[0];
  return { key: '@' + d, name: domainRule?.name || rule?.name || base.charAt(0).toUpperCase() + base.slice(1), domain: d };
}

const signalsFrom = (row) => (row.signals != null ? (row.signals ? row.signals.split(',') : []) : signalsOf(row.subject, row.snippet));

/** 综合评分：客户等级 × 业务意图 × 等待时长 × 收件方式 */
export function scoreRow(idx, row, { slaHours = 24, at = now() } = {}) {
  const tier = tierOf(idx, row.from_addr, row.category);
  const signals = signalsFrom(row);
  let score = TIER_SCORE[tier] ?? 0;
  score += Math.min(40, signals.reduce((s, k) => s + (SIGNAL_SCORE[k] || 0), 0));
  if (tier === 'new' && signals.includes('inquiry')) score += 14;
  const waitingHours = Math.max(0, (at - row.date) / HOUR);
  score += Math.min(25, (waitingHours / slaHours) * 25);
  const overdue = waitingHours >= slaHours;
  if (overdue) score += 8;
  const to = JSON.parse(row.to_json || '[]').map((a) => String(a.address || '').toLowerCase());
  const direct = to.some((a) => idx.own.has(a));
  if (direct) score += 4;
  else if (to.length) score -= 12;
  if (row.flagged) score += 15;
  if (row.has_att) score += 3;
  if (!row.seen) score += 3;
  score = Math.round(score);
  const level = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low';
  const reasons = [];
  if (TIER_LABEL[tier]) reasons.push(tier === 'new' && signals.includes('inquiry') ? '新询盘' : TIER_LABEL[tier]);
  for (const s of signals) if (SIGNAL_LABEL[s] && s !== 'question') reasons.push(SIGNAL_LABEL[s]);
  if (!direct && to.length) reasons.push('抄送我');
  return { score, level, tier, signals, reasons, waitingHours: Math.round(waitingHours * 10) / 10, overdue };
}

// ---------- 今日待办 ----------
const BASE_SELECT = `SELECT m.*, f.special_use, b.email AS mb_email,
  (SELECT COUNT(DISTINCT IFNULL(t.message_id, t.id)) FROM messages t WHERE t.mailbox_id = m.mailbox_id AND t.thread_id = m.thread_id AND m.thread_id IS NOT NULL) AS thread_count,
  ${MY_LAST_SQL} AS my_last`;

function replyCandidates(userId, mailboxId, since) {
  return db
    .prepare(
      `${BASE_SELECT}
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = @userId AND (@mb = 'all' OR m.mailbox_id = @mb) AND f.special_use = '\\Inbox'
         AND m.date >= @since AND m.from_addr != b.email
       ORDER BY m.date DESC LIMIT 800`
    )
    .all({ userId, mb: mailboxId, since });
}

function sentCandidates(userId, mailboxId, since) {
  return db
    .prepare(
      `${BASE_SELECT},
        (SELECT MAX(t.date) FROM messages t JOIN mailboxes tb ON tb.id = t.mailbox_id
          WHERE tb.user_id = b.user_id AND m.thread_id IS NOT NULL AND t.thread_id = m.thread_id
            AND t.from_addr NOT IN (SELECT email FROM mailboxes WHERE user_id = b.user_id)) AS their_last
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = @userId AND (@mb = 'all' OR m.mailbox_id = @mb) AND f.special_use = '\\Sent'
         AND m.from_addr = b.email AND m.date >= @since
       ORDER BY m.date DESC LIMIT 400`
    )
    .all({ userId, mb: mailboxId, since });
}

/** 是否已经处理（回复过 / 标记完成 / 稍后处理中） */
const handled = (r) => r.answered || r.done_at || r.snooze_until || (r.my_last && r.my_last > r.date);

export function focus(userId, settings = {}, { mailboxId = 'all', dayStart } = {}) {
  const at = now();
  const slaHours = Number(settings.replySlaHours) || 24;
  const followDays = Number(settings.followupDays) || 3;
  const today = Number(dayStart) || new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const idx = relationIndex(userId);

  // 需要我回复：同一会话只保留最新一封，同一封邮件（多个邮箱都收到）只算一次
  const seenMsg = new Set();
  const seenThread = new Set();
  const reply = [];
  let todayIn = 0;
  let doneToday = 0;
  for (const r of replyCandidates(userId, mailboxId, at - REPLY_WINDOW)) {
    const mk = r.message_id || `#${r.id}`;
    if (seenMsg.has(mk)) continue;
    seenMsg.add(mk);
    const tier = tierOf(idx, r.from_addr, r.category);
    const person = ['vip', 'customer', 'new', 'colleague'].includes(tier);
    if (r.date >= today && person && tier !== 'colleague') todayIn++;
    if (r.done_at && r.done_at >= today) doneToday++;
    const tk = r.thread_id || mk;
    if (seenThread.has(tk)) continue;
    seenThread.add(tk);
    if (!person || handled(r)) continue;
    if (r.category === 'notification' && tier !== 'vip' && tier !== 'customer') continue;
    const p = scoreRow(idx, r, { slaHours, at });
    reply.push({ ...rowToMessage(r), priority: { ...p, company: companyOf(idx, { address: r.from_addr, name: r.from_name }) } });
  }
  reply.sort((a, b) => b.priority.score - a.priority.score || b.date - a.date);

  // 等待对方回复：我最后发出、对方还没回、已超过跟进天数
  const followups = [];
  const seenFollow = new Set();
  let repliedToday = 0;
  for (const r of sentCandidates(userId, mailboxId, at - FOLLOW_WINDOW)) {
    const mk = r.message_id || `#${r.id}`;
    if (r.date >= today && r.thread_id && r.thread_id !== r.message_id) repliedToday++;
    const tk = r.thread_id || mk;
    if (seenFollow.has(tk)) continue;
    seenFollow.add(tk);
    if (r.nudge_off || r.snooze_until) continue;
    if (r.my_last && r.my_last > r.date) continue;
    if (r.their_last && r.their_last > r.date) continue;
    if (at - r.date < followDays * DAY) continue;
    const to = JSON.parse(r.to_json || '[]');
    const external = to.find((a) => {
      const addr = String(a.address || '').toLowerCase();
      return addr && !idx.own.has(addr) && !idx.ownDomains.has(domainOf(addr)) && !ROBOT.test(addr);
    });
    if (!external || !expectsReply(r.subject, r.snippet)) continue;
    const tier = tierOf(idx, external.address);
    const days = Math.floor((at - r.date) / DAY);
    const signals = signalsFrom(r);
    const score = (TIER_SCORE[tier] || 0) + Math.min(30, days * 4) + (signals.includes('inquiry') || signals.includes('sample') ? 10 : 0);
    followups.push({
      ...rowToMessage(r),
      follow: { days, tier, to: external, score, company: companyOf(idx, external), signals },
    });
  }
  followups.sort((a, b) => b.follow.score - a.follow.score);

  const overdue = reply.filter((m) => m.priority.overdue).length;
  return {
    reply,
    followups,
    stats: {
      needReply: reply.length,
      overdue,
      high: reply.filter((m) => m.priority.level === 'high').length,
      followups: followups.length,
      todayIn,
      handledToday: repliedToday + doneToday,
    },
    settings: { slaHours, followDays },
  };
}

/** 普通列表的轻量标注：客户等级、业务意图、是否待回复 */
export function decorate(userId, rows, settings = {}) {
  const idx = relationIndex(userId);
  const slaHours = Number(settings.replySlaHours) || 24;
  const at = now();
  return rows.map((r) => {
    const m = rowToMessage(r);
    if (r.special_use !== '\\Inbox') return m;
    const tier = tierOf(idx, r.from_addr, r.category);
    const awaiting = ['vip', 'customer', 'new'].includes(tier) && !handled(r) && at - r.date < REPLY_WINDOW;
    const waitingHours = (at - r.date) / HOUR;
    return { ...m, tier, awaiting, overdue: awaiting && waitingHours >= slaHours };
  });
}

/** 新邮件到达时判断是否值得重点提醒 */
export function importance(userId, item) {
  const idx = relationIndex(userId);
  const tier = tierOf(idx, item.from?.address, item.category);
  const signals = signalsOf(item.subject, item.snippet);
  const important = tier === 'vip' || (tier === 'customer' && signals.some((s) => ['urgent', 'complaint', 'order', 'payment'].includes(s))) ||
    (tier === 'new' && signals.includes('inquiry'));
  return { tier, important, label: tier === 'vip' ? 'VIP 客户' : tier === 'new' ? '新询盘' : tier === 'customer' ? '客户' : '' };
}

/** 发件人画像：往来统计 */
export function senderInfo(userId, address) {
  const a = String(address || '').toLowerCase();
  if (!a) return null;
  const idx = relationIndex(userId);
  const tier = tierOf(idx, a);
  const st = db
    .prepare(
      `SELECT
        SUM(CASE WHEN m.from_addr = ? THEN 1 ELSE 0 END) AS received,
        MAX(CASE WHEN m.from_addr = ? THEN m.date END) AS last_received,
        MAX(CASE WHEN m.from_addr = b.email THEN m.date END) AS last_sent
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND (m.from_addr = ? OR (m.from_addr = b.email AND (m.to_json LIKE ? OR m.cc_json LIKE ?)))`
    )
    .get(a, a, userId, a, `%"${a}"%`, `%"${a}"%`);
  const rule = ruleFor(idx, a);
  return {
    tier,
    rule: rule ? { key: rule.key, kind: rule.kind, name: rule.name } : null,
    company: companyOf(idx, { address: a }),
    received: st?.received || 0,
    sent: idx.wrote.get(a) || 0,
    lastReceived: st?.last_received || null,
    lastSent: st?.last_sent || null,
  };
}

// ---------- 发件人规则（VIP / 静音） ----------
export function normalizeKey(input) {
  let k = String(input || '').trim().toLowerCase();
  if (!k) return '';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k)) return k;
  k = k.replace(/^@/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(k) ? '@' + k : '';
}
export const listRules = (userId) => db.prepare('SELECT key, kind, name, created_at FROM sender_rules WHERE user_id = ? ORDER BY kind, key').all(userId);
export function saveRule(userId, { key, kind, name }) {
  const k = normalizeKey(key);
  if (!k) throw new Error('请输入邮箱地址或域名，例如 buyer@acme.com 或 @acme.com');
  if (!['vip', 'muted'].includes(kind)) throw new Error('规则类型不正确');
  db.prepare(
    `INSERT INTO sender_rules (user_id, key, kind, name, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET kind = excluded.kind, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`
  ).run(userId, k, kind, String(name || '').trim().slice(0, 60), now());
  invalidate(userId);
  return k;
}
export function deleteRule(userId, key) {
  db.prepare('DELETE FROM sender_rules WHERE user_id = ? AND key = ?').run(userId, String(key || '').toLowerCase());
  invalidate(userId);
}

// ---------- 超时提醒 ----------
export function overdueToRemind(userId, settings) {
  const data = focus(userId, settings);
  const fresh = data.reply.filter((m) => m.priority.overdue && m.priority.tier !== 'colleague');
  const ids = fresh.map((m) => m.id);
  if (!ids.length) return null;
  const pending = db.prepare(`SELECT id FROM messages WHERE reminded = 0 AND id IN (${ids.join(',')})`).all().map((r) => r.id);
  if (!pending.length) return null;
  db.prepare(`UPDATE messages SET reminded = 1 WHERE id IN (${pending.join(',')})`).run();
  const set = new Set(pending);
  const items = fresh.filter((m) => set.has(m.id));
  return { count: items.length, total: data.stats.overdue, items: items.slice(0, 3).map((m) => ({ id: m.id, subject: m.subject, from: m.from })) };
}
