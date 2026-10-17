import { db, now } from './db.js';
import { MY_LAST_SQL, THEIR_LAST_SQL, rowToMessage, conversationKey } from './repo.js';
import { expectsReply, signalsOf } from './classify.js';
import { attachDeals, dueFollowDeals } from './deals.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const REPLY_WINDOW = 21 * DAY;
const FOLLOW_WINDOW = 30 * DAY;

/** 分层 SLA：VIP / 老客户 / 新询盘可不同时限；其余回落到 replySlaHours */
export function slaFor(settings = {}, tier, signals = []) {
  const base = Number(settings.replySlaHours) || 24;
  if (tier === 'vip') return Number(settings.slaVipHours) || Math.min(4, base);
  if (tier === 'new' && (signals || []).includes('inquiry')) {
    return Number(settings.slaNewInquiryHours) || Math.min(8, base);
  }
  if (tier === 'customer') return Number(settings.slaCustomerHours) || base;
  return base;
}

export function slaByTier(settings = {}) {
  const base = Number(settings.replySlaHours) || 24;
  return {
    vip: Number(settings.slaVipHours) || Math.min(4, base),
    customer: Number(settings.slaCustomerHours) || base,
    inquiry: Number(settings.slaNewInquiryHours) || Math.min(8, base),
    default: base,
  };
}

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
const SIGNAL_SCORE = {
  urgent: 22, complaint: 22, order: 20, payment: 18, inquiry: 14, sample: 12, fabric: 9, fit: 9, shipping: 8, question: 6,
};
const SIGNAL_LABEL = {
  urgent: '紧急', complaint: '投诉', order: '订单', payment: '付款', inquiry: '询盘', sample: '样品',
  fabric: '面料', fit: '尺码', shipping: '物流', question: '有提问',
};
const TIER_LABEL = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事' };

// ---------- 发件人关系索引 ----------
const cache = new Map();
export const invalidate = (userId) => cache.delete(userId);

/** 关系索引只扫近 180 天、最多 3000 封已发——对「是否老客户」足够，避免全库 JSON 解析 */
const RELATION_LOOKBACK = 180 * DAY;
const RELATION_SENT_CAP = 3000;

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
       WHERE b.user_id = ? AND m.from_addr = b.email
         AND m.date >= ?
         AND IFNULL(f.special_use, '') NOT IN ('\\Drafts', '\\Trash')
       ORDER BY m.date DESC
       LIMIT ?`
    )
    .all(userId, now() - RELATION_LOOKBACK, RELATION_SENT_CAP);
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

/** 综合评分：客户等级 × 业务意图 × 等待时长 × 收件方式；hits 供 UI 验真 */
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
  const hits = [];
  const tierLabel = tier === 'new' && signals.includes('inquiry') ? '新询盘' : TIER_LABEL[tier];
  if (tierLabel) hits.push({ code: 'tier_' + tier, label: tierLabel });
  for (const s of signals) {
    if (SIGNAL_LABEL[s] && s !== 'question') hits.push({ code: 'signal_' + s, label: SIGNAL_LABEL[s] });
  }
  if (!direct && to.length) hits.push({ code: 'cc_only', label: '抄送我' });
  if (direct) hits.push({ code: 'to_me', label: '直接发给我' });
  if (row.flagged) hits.push({ code: 'flagged', label: '已加星' });
  if (!row.seen) hits.push({ code: 'unseen', label: '未读' });
  const waitingHoursR = Math.round(waitingHours * 10) / 10;
  if (slaHours != null) hits.push({ code: 'sla', label: `时限 ${slaHours}h`, detail: { slaHours } });
  if (overdue) hits.push({ code: 'overdue', label: '已超时未回' });
  else if (waitingHoursR >= 1) hits.push({ code: 'waiting', label: `已等 ${waitingHoursR}h`, detail: { hours: waitingHoursR } });
  const conv = conversationKey(row);
  if (conv) hits.push({ code: 'conv', label: '会话键', detail: { conversationKey: String(conv).slice(0, 80) } });
  const reasons = hits.filter((h) => !['to_me', 'unseen', 'conv', 'flagged'].includes(h.code)).map((h) => h.label);
  const whyParts = [...reasons];
  return {
    score,
    level,
    tier,
    signals,
    reasons: [...new Set(reasons)].slice(0, 8),
    hits: hits.slice(0, 12),
    why: [...new Set(whyParts.filter(Boolean))].slice(0, 6).join(' · '),
    waitingHours: waitingHoursR,
    overdue,
    slaHours,
  };
}

function followHits(f) {
  const hits = [];
  if (f.due) hits.push({ code: 'follow_due', label: '跟进日到期' });
  else if (f.nextFollowAt) hits.push({ code: 'follow_planned', label: '已设跟进日' });
  if (f.tier === 'vip') hits.push({ code: 'tier_vip', label: 'VIP' });
  else if (f.tier === 'customer') hits.push({ code: 'tier_customer', label: '老客户' });
  else if (f.tier === 'new') hits.push({ code: 'tier_new', label: '新联系人' });
  for (const s of f.signals || []) {
    if (SIGNAL_LABEL[s] && s !== 'question') hits.push({ code: 'signal_' + s, label: SIGNAL_LABEL[s] });
  }
  if (f.days != null) hits.push({ code: 'days_waiting', label: `${f.days} 天未回` });
  hits.push({ code: 'awaiting_them', label: '对方尚未回复' });
  return hits.slice(0, 12);
}

function followWhy(f) {
  return [...new Set(followHits(f).map((h) => h.label).filter(Boolean))].slice(0, 6).join(' · ');
}

// ---------- 今日待办 ----------
const BASE_SELECT = `SELECT m.*, f.special_use, b.email AS mb_email,
  (SELECT COUNT(DISTINCT IFNULL(t.message_id, t.id)) FROM messages t WHERE t.mailbox_id = m.mailbox_id AND t.thread_id = m.thread_id AND m.thread_id IS NOT NULL) AS thread_count,
  ${MY_LAST_SQL} AS my_last`;

/** Focus 候选上限：配合窗口天数；高峰期另补 VIP/未读急件 */
const REPLY_CANDIDATE_CAP = 900;
const SENT_CANDIDATE_CAP = 500;

function replyCandidates(userId, mailboxId, since) {
  return db
    .prepare(
      `${BASE_SELECT}
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = @userId AND (@mb = 'all' OR m.mailbox_id = @mb) AND f.special_use = '\\Inbox'
         AND m.date >= @since AND m.from_addr != b.email
         AND (
           IFNULL(m.skip_inbox, 0) = 0
           OR EXISTS (
             SELECT 1 FROM sender_rules sr
             WHERE sr.user_id = b.user_id AND sr.kind = 'vip'
               AND (sr.key = lower(m.from_addr) OR (sr.key LIKE '@%' AND lower(m.from_addr) LIKE '%' || sr.key))
           )
         )
       ORDER BY m.date DESC LIMIT ${REPLY_CANDIDATE_CAP}`
    )
    .all({ userId, mb: mailboxId, since });
}

function sentCandidates(userId, mailboxId, since) {
  return db
    .prepare(
      `${BASE_SELECT},
        ${THEIR_LAST_SQL} AS their_last
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = @userId AND (@mb = 'all' OR m.mailbox_id = @mb) AND f.special_use = '\\Sent'
         AND m.from_addr = b.email AND m.date >= @since
       ORDER BY m.date DESC LIMIT ${SENT_CANDIDATE_CAP}`
    )
    .all({ userId, mb: mailboxId, since });
}

/** 硬帽之外再捞 VIP/未读超时，避免高峰急件进不了今日待办 */
function replyBoostCandidates(userId, mailboxId, since, excludeIds) {
  const excl = excludeIds?.size
    ? `AND m.id NOT IN (${[...excludeIds].map(Number).filter(Number.isInteger).join(',') || '0'})`
    : '';
  return db
    .prepare(
      `${BASE_SELECT}
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = @userId AND (@mb = 'all' OR m.mailbox_id = @mb) AND f.special_use = '\\Inbox'
         AND m.date >= @since AND m.from_addr != b.email AND m.seen = 0 AND IFNULL(m.answered, 0) = 0
         AND IFNULL(m.done_at, 0) = 0 AND m.snooze_until IS NULL
         ${excl}
         AND EXISTS (
           SELECT 1 FROM sender_rules sr
           WHERE sr.user_id = b.user_id AND sr.kind = 'vip'
             AND (sr.key = lower(m.from_addr) OR (sr.key LIKE '@%' AND lower(m.from_addr) LIKE '%' || sr.key))
         )
       ORDER BY m.date DESC LIMIT 80`
    )
    .all({ userId, mb: mailboxId, since });
}

/** 是否已经处理（回复过 / 标记完成 / 稍后处理中） */
const handled = (r) => r.answered || r.done_at || r.snooze_until || (r.my_last && r.my_last > r.date);

export function focus(userId, settings = {}, { mailboxId = 'all', dayStart } = {}) {
  const at = now();
  const slaHours = Number(settings.replySlaHours) || 24;
  const tiers = slaByTier(settings);
  const followDays = Number(settings.followupDays) || 3;
  const today = Number(dayStart) || new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const idx = relationIndex(userId);

  // 需要我回复：同一会话只保留最新一封，同一封邮件（多个邮箱都收到）只算一次
  const seenMsg = new Set();
  const seenThread = new Set();
  const reply = [];
  let todayIn = 0;
  let doneToday = 0;
  const seenIds = new Set();
  const pushReplyRow = (r) => {
    const mk = r.message_id || `#${r.id}`;
    if (seenMsg.has(mk)) return;
    seenMsg.add(mk);
    seenIds.add(r.id);
    const tier = tierOf(idx, r.from_addr, r.category);
    const person = ['vip', 'customer', 'new', 'colleague'].includes(tier);
    if (r.date >= today && person && tier !== 'colleague') todayIn++;
    if (r.done_at && r.done_at >= today) doneToday++;
    const tk = conversationKey(r) || mk;
    if (seenThread.has(tk)) return;
    seenThread.add(tk);
    if (!person || handled(r)) return;
    if (r.category === 'notification' && tier !== 'vip' && tier !== 'customer') return;
    const sigs = signalsFrom(r);
    const p = scoreRow(idx, r, { slaHours: slaFor(settings, tier, sigs), at });
    reply.push({ ...rowToMessage(r), priority: { ...p, company: companyOf(idx, { address: r.from_addr, name: r.from_name }) } });
  };
  for (const r of replyCandidates(userId, mailboxId, at - REPLY_WINDOW)) pushReplyRow(r);
  for (const r of replyBoostCandidates(userId, mailboxId, at - REPLY_WINDOW, seenIds)) pushReplyRow(r);
  reply.sort((a, b) => b.priority.score - a.priority.score || b.date - a.date);

  // 等待对方回复：我最后发出、对方还没回、已超过跟进天数
  const followups = [];
  const seenFollow = new Set();
  let repliedToday = 0;
  for (const r of sentCandidates(userId, mailboxId, at - FOLLOW_WINDOW)) {
    const mk = r.message_id || `#${r.id}`;
    if (r.date >= today && r.thread_id && r.thread_id !== r.message_id) repliedToday++;
    const tk = conversationKey(r) || mk;
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
    const follow = { days, tier, to: external, score, company: companyOf(idx, external), signals };
    follow.hits = followHits(follow);
    follow.why = followWhy(follow);
    followups.push({
      ...rowToMessage(r),
      follow,
    });
  }
  followups.sort((a, b) => b.follow.score - a.follow.score);

  const overdueList = reply.filter((m) => m.priority.overdue);
  const overdue = overdueList.length;
  const byTier = { vip: 0, customer: 0, new: 0, other: 0 };
  let oldestHours = 0;
  for (const m of overdueList) {
    const t = m.priority.tier;
    if (t in byTier) byTier[t]++;
    else byTier.other++;
    if (m.priority.waitingHours > oldestHours) oldestHours = m.priority.waitingHours;
  }
  // Soft UI field: remind stage 0–3 from messages.reminded (push escalate)
  if (overdueList.length) {
    const ids = overdueList.map((m) => m.id);
    const ph = ids.map(() => '?').join(',');
    const stages = new Map(
      db.prepare(`SELECT id, reminded FROM messages WHERE id IN (${ph})`).all(...ids).map((r) => [r.id, Number(r.reminded) || 0])
    );
    for (const m of reply) {
      if (m.priority?.overdue) m.remindStage = stages.get(m.id) || 0;
    }
  }
  let replyWithDeals = attachDeals(userId, reply);
  // 我已认领：抬分置顶，减少「认了却找不到」
  replyWithDeals = replyWithDeals
    .map((m) => {
      if (!m.deal?.mine || !m.priority) return m;
      const score = (m.priority.score || 0) + 28;
      const hit = { code: 'claimed_boost', label: '我已认领' };
      const hits = [hit, ...(m.priority.hits || [])].slice(0, 12);
      const why = ['我已认领', m.priority.why].filter(Boolean).join(' · ');
      return {
        ...m,
        priority: { ...m.priority, score, why, hits, claimedBoost: true },
      };
    })
    .sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0) || b.date - a.date);
  let followWithDeals = attachDeals(userId, followups);

  // 跟进日闭环：到期认领客户必出现在待跟进（即使未满全局 followDays）
  const atNow = Date.now();
  const dueDeals = dueFollowDeals(userId, atNow);
  const followScope = new Set(
    followWithDeals.map((m) => m.deal?.scopeKey).filter(Boolean)
  );
  for (const d of dueDeals) {
    if (followScope.has(d.scopeKey)) continue;
    const sent = latestSentForDeal(userId, d);
    if (!sent) continue;
    if (sent.nudge_off || sent.snooze_until) continue;
    // 对方已回 / 我又发了更新信 → 不注入，避免「已回仍等待」
    if (sent.their_last && sent.their_last > sent.date) continue;
    if (sent.my_last && sent.my_last > sent.date) continue;
    followScope.add(d.scopeKey);
    const to = { name: '', address: d.lastAddress || '' };
    const follow = {
      days: Math.floor((atNow - sent.date) / DAY),
      tier: tierOf(idx, d.lastAddress),
      to,
      score: 120,
      company: companyOf(idx, d.lastAddress),
      signals: signalsFrom(sent),
      nextFollowAt: d.nextFollowAt,
      due: true,
    };
    follow.hits = followHits(follow);
    follow.why = followWhy(follow);
    followWithDeals.push({
      ...rowToMessage(sent),
      deal: d,
      follow,
      _section: undefined,
    });
  }

  followWithDeals = followWithDeals
    .map((m) => {
      const nf = m.deal?.nextFollowAt || m.follow?.nextFollowAt;
      if (!nf) return m;
      const due = nf <= atNow;
      // 未到期：仍可在列表但降权；到期强提升
      const dueBoost = due ? 80 : nf <= atNow + DAY ? 40 : nf <= atNow + 3 * DAY ? 15 : 0;
      const follow = {
        ...m.follow,
        nextFollowAt: nf,
        score: (m.follow?.score || 0) + dueBoost,
        due,
      };
      follow.hits = followHits(follow);
      follow.why = followWhy(follow);
      return { ...m, follow };
    })
    .filter((m) => {
      const nf = m.follow?.nextFollowAt;
      if (!nf) return true;
      // 未到期且未满全局跟进天数 → 先不进「等待对方」（避免噪音）；到期必出现
      if (nf > atNow && (m.follow?.days || 0) < followDays && !m.follow?.due) return false;
      return true;
    })
    .sort((a, b) => (b.follow?.score || 0) - (a.follow?.score || 0));

  // 标注「今日收到仍未回」，供前端拆段与明细
  const replyMarked = replyWithDeals.map((m) => ({
    ...m,
    receivedToday: m.date >= today,
  }));
  const todayUnreplied = replyMarked.filter((m) => m.receivedToday);
  const olderUnreplied = replyMarked.filter((m) => !m.receivedToday);

  return {
    reply: replyMarked,
    followups: followWithDeals,
    stats: {
      needReply: replyMarked.length,
      overdue,
      high: replyMarked.filter((m) => m.priority.level === 'high').length,
      followups: followWithDeals.length,
      /** 侧栏「等待」角标：等我 / 等对方 */
      waitingMine: replyMarked.length,
      waitingThem: followWithDeals.length,
      todayIn,
      /** 今日收到且仍待你回复（明细见 todayUnreplied） */
      todayUnreplied: todayUnreplied.length,
      olderUnreplied: olderUnreplied.length,
      handledToday: repliedToday + doneToday,
    },
    /** 今日未回清单（按最新来信），方便一眼看清「今天谁还没回」 */
    todayUnreplied: todayUnreplied
      .slice()
      .sort((a, b) => b.date - a.date)
      .map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        date: m.date,
        waitingHours: m.priority?.waitingHours,
        overdue: !!m.priority?.overdue,
        tier: m.priority?.tier,
        level: m.priority?.level,
        why: m.priority?.why || '',
        deal: m.deal
          ? { stage: m.deal.stage, stageLabel: m.deal.stageLabel, mine: m.deal.mine, scopeLabel: m.deal.scopeLabel }
          : null,
      })),
    overdueSummary: {
      count: overdue,
      byTier,
      oldestHours: Math.round(oldestHours * 10) / 10,
      top: overdueList.slice(0, 3).map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        tier: m.priority.tier,
        waitingHours: m.priority.waitingHours,
        slaHours: m.priority.slaHours,
      })),
    },
    settings: { slaHours, followDays, slaByTier: tiers },
  };
}

/**
 * 单封验真：是否在今日待办/等待，以及进/出原因（供 UI 与排查）
 * hits / outHits：结构化规则命中，便于点开验真
 */
export function explainMessage(userId, messageId, settings = {}) {
  const id = Number(messageId);
  if (!Number.isInteger(id)) {
    return { inFocus: false, section: null, why: '', out: ['无效邮件'], hits: [], outHits: [{ code: 'bad_id', label: '无效邮件' }] };
  }
  const data = focus(userId, settings);
  const inReply = data.reply.find((m) => m.id === id);
  if (inReply) {
    const hits = inReply.priority?.hits || [];
    return {
      inFocus: true,
      section: 'reply',
      why: inReply.priority?.why || (inReply.priority?.reasons || []).join(' · '),
      hits,
      out: [],
      outHits: [],
      priority: inReply.priority,
      caps: { replyCandidate: REPLY_CANDIDATE_CAP, replyWindowDays: 21 },
    };
  }
  const inFollow = data.followups.find((m) => m.id === id);
  if (inFollow) {
    const f = inFollow.follow || {};
    const hits = f.hits?.length ? f.hits : followHits(f);
    return {
      inFocus: true,
      section: 'follow',
      why: f.why || '',
      hits,
      out: [],
      outHits: [],
      follow: f,
      caps: { followWindowDays: 30 },
    };
  }

  const row = db
    .prepare(
      `SELECT m.*, f.special_use, b.email AS mb_email, ${MY_LAST_SQL} AS my_last, ${THEIR_LAST_SQL} AS their_last
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ? AND m.id = ?`
    )
    .get(userId, id);
  if (!row) {
    return {
      inFocus: false,
      section: null,
      why: '',
      out: ['邮件不存在或不属于你'],
      hits: [],
      outHits: [{ code: 'missing', label: '邮件不存在或不属于你' }],
    };
  }

  const outHits = [];
  const at = now();
  const idx = relationIndex(userId);
  if (row.special_use === '\\Inbox') {
    const tier = tierOf(idx, row.from_addr, row.category);
    if (handled(row)) {
      if (row.answered || (row.my_last && row.my_last > row.date)) {
        outHits.push({ code: 'answered', label: '你已回复（不再进待办）' });
      }
      if (row.done_at) outHits.push({ code: 'done', label: '已标记处理完成' });
      if (row.snooze_until) outHits.push({ code: 'snoozed', label: '稍后处理中' });
    }
    if (!['vip', 'customer', 'new', 'colleague'].includes(tier)) {
      outHits.push({ code: 'tier_filtered', label: `关系档位「${tier}」不进今日待办` });
    }
    if (row.category === 'notification' && tier !== 'vip' && tier !== 'customer') {
      outHits.push({ code: 'notification', label: '通知类邮件已过滤' });
    }
    if (at - row.date > REPLY_WINDOW) outHits.push({ code: 'reply_window', label: '超出待办时间窗（21 天）' });
    const conv = conversationKey(row);
    if (!outHits.length) {
      outHits.push({
        code: 'cap_or_dedupe',
        label: '未进入候选（会话去重或硬帽截断）',
        detail: { conversationKey: conv ? String(conv).slice(0, 80) : null, replyCandidateCap: REPLY_CANDIDATE_CAP },
      });
    }
  } else if (row.special_use === '\\Sent') {
    if (row.nudge_off) outHits.push({ code: 'nofollow', label: '已标记无需跟进' });
    if (row.their_last && row.their_last > row.date) outHits.push({ code: 'they_replied', label: '对方已回复' });
    if (row.my_last && row.my_last > row.date) outHits.push({ code: 'newer_sent', label: '你有更新的发信' });
    const followDays = Number(settings.followupDays) || 3;
    if (at - row.date < followDays * DAY) {
      outHits.push({ code: 'follow_days', label: `未满跟进天数（${followDays} 天）` });
    }
    if (!expectsReply(row.subject, row.snippet)) {
      outHits.push({ code: 'expects_reply_false', label: '主题/摘要判断为无需跟进' });
    }
    if (at - row.date > FOLLOW_WINDOW) outHits.push({ code: 'follow_window', label: '超出等待时间窗（30 天）' });
    if (!outHits.length) outHits.push({ code: 'not_in_follow', label: '未进入等待列表' });
  } else {
    outHits.push({ code: 'wrong_folder', label: '非收件箱/已发送，不参与今日待办与等待' });
  }
  const out = outHits.map((h) => h.label);
  return {
    inFocus: false,
    section: null,
    why: '',
    hits: [],
    out,
    outHits,
    caps: { replyCandidate: REPLY_CANDIDATE_CAP, replyWindowDays: 21, followWindowDays: 30 },
  };
}

/** 认领客户到期时，用最近发给对方的已发送邮件挂到「等待」 */
function latestSentForDeal(userId, deal) {
  if (!deal?.lastAddress && !deal?.scopeKey) return null;
  const addr = String(deal.lastAddress || '').toLowerCase();
  const domain = deal.scopeKind === 'company' ? String(deal.scopeLabel || '').replace(/^@/, '') : '';
  const select = `SELECT m.*, f.special_use, b.email AS mb_email,
    ${MY_LAST_SQL} AS my_last, ${THEIR_LAST_SQL} AS their_last
    FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
    LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
    WHERE b.user_id = ? AND f.special_use = '\\Sent' AND m.from_addr = b.email`;
  if (addr) {
    const row = db
      .prepare(`${select} AND (m.to_json LIKE ? OR m.cc_json LIKE ?) ORDER BY m.date DESC LIMIT 1`)
      .get(userId, `%${addr}%`, `%${addr}%`);
    if (row) return row;
  }
  if (domain) {
    return db
      .prepare(`${select} AND (m.to_json LIKE ? OR m.cc_json LIKE ?) ORDER BY m.date DESC LIMIT 1`)
      .get(userId, `%@${domain}%`, `%@${domain}%`);
  }
  return null;
}

/** 批量取会话中对方最后回信时间（用于已发送「等对方」） */
function theirLastByThread(userId, threadIds) {
  const ids = [...new Set(threadIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.thread_id AS tid, MAX(m.date) AS their_last
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND m.thread_id IN (${ph})
         AND m.from_addr NOT IN (SELECT email FROM mailboxes WHERE user_id = ?)
       GROUP BY m.thread_id`
    )
    .all(userId, ...ids, userId);
  for (const r of rows) map.set(r.tid, r.their_last);
  return map;
}

function externalRecipient(idx, toJson) {
  const to = JSON.parse(toJson || '[]');
  return to.find((a) => {
    const addr = String(a.address || '').toLowerCase();
    return addr && !idx.own.has(addr) && !idx.ownDomains.has(domainOf(addr)) && !ROBOT.test(addr);
  }) || null;
}

/** 普通列表的轻量标注：待我回 / 等对方 / 超时 */
export function decorate(userId, rows, settings = {}) {
  const idx = relationIndex(userId);
  const at = now();
  const sentThreads = rows.filter((r) => r.special_use === '\\Sent' && r.thread_id).map((r) => r.thread_id);
  const theirLast = theirLastByThread(userId, sentThreads);

  return rows.map((r) => {
    const m = rowToMessage(r);

    if (r.special_use === '\\Inbox') {
      const tier = tierOf(idx, r.from_addr, r.category);
      const signals = signalsFrom(r);
      const sla = slaFor(settings, tier, signals);
      const awaiting = ['vip', 'customer', 'new'].includes(tier) && !handled(r) && at - r.date < REPLY_WINDOW;
      const waitingHours = (at - r.date) / HOUR;
      // 我已回复（answered / my_last 晚于来信）且未关闭 → 等对方
      const replied = !!(r.answered || (r.my_last && r.my_last > r.date));
      const waitingOnThem =
        !awaiting &&
        replied &&
        ['vip', 'customer', 'new'].includes(tier) &&
        !r.done_at &&
        !r.snooze_until &&
        !r.nudge_off &&
        at - (r.my_last || r.date) < FOLLOW_WINDOW;
      return {
        ...m,
        tier,
        awaiting,
        overdue: awaiting && waitingHours >= sla,
        slaHours: sla,
        waitingOnThem,
      };
    }

    if (r.special_use === '\\Sent') {
      if (r.nudge_off || r.snooze_until) return m;
      if (r.my_last && r.my_last > r.date) return m;
      const their = r.thread_id ? theirLast.get(r.thread_id) : null;
      if (their && their > r.date) return m;
      if (!expectsReply(r.subject, r.snippet)) return m;
      const external = externalRecipient(idx, r.to_json);
      if (!external) return m;
      const days = Math.floor((at - r.date) / DAY);
      return {
        ...m,
        waitingOnThem: true,
        waitingDays: days,
        tier: tierOf(idx, external.address),
      };
    }

    return m;
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

/**
 * 团队询盘冲突提示（MVP）：其他同事近 14 天是否与同一买家/同公司有过往来。
 * 公共邮箱只按完整地址匹配；企业域可按域名聚合。
 */
export function conflictHints(userId, { fromAddr, threadId } = {}) {
  const a = String(fromAddr || '').toLowerCase();
  if (!a || ROBOT.test(a)) return null;
  const d = domainOf(a);
  const since = now() - 14 * DAY;
  const likeAddr = `%"${a}"%`;
  const useDomain = !!(d && !isFreeDomain(d));
  const likeDomain = useDomain ? `%@${d}%` : null;

  const peers = useDomain
    ? db
        .prepare(
          `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email,
                  MAX(CASE WHEN m.from_addr = b.email THEN m.date END) AS last_sent,
                  MAX(CASE WHEN lower(m.from_addr) = ? THEN m.date END) AS last_recv,
                  SUM(CASE WHEN m.from_addr = b.email THEN 1 ELSE 0 END) AS sent_n,
                  SUM(CASE WHEN lower(m.from_addr) LIKE ? THEN 1 ELSE 0 END) AS recv_n
           FROM messages m
           JOIN mailboxes b ON b.id = m.mailbox_id
           JOIN users u ON u.id = b.user_id
           WHERE b.user_id != ?
             AND m.date >= ?
             AND (
               lower(m.from_addr) LIKE ?
               OR m.to_json LIKE ? OR m.cc_json LIKE ?
               OR m.to_json LIKE ? OR m.cc_json LIKE ?
             )
           GROUP BY u.id
           HAVING sent_n > 0 OR recv_n > 0
           ORDER BY IFNULL(last_sent, 0) DESC, IFNULL(last_recv, 0) DESC
           LIMIT 5`
        )
        .all(a, `%@${d}`, userId, since, `%@${d}`, likeAddr, likeAddr, likeDomain, likeDomain)
    : db
        .prepare(
          `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email,
                  MAX(CASE WHEN m.from_addr = b.email THEN m.date END) AS last_sent,
                  MAX(CASE WHEN lower(m.from_addr) = ? THEN m.date END) AS last_recv,
                  SUM(CASE WHEN m.from_addr = b.email THEN 1 ELSE 0 END) AS sent_n,
                  SUM(CASE WHEN lower(m.from_addr) = ? THEN 1 ELSE 0 END) AS recv_n
           FROM messages m
           JOIN mailboxes b ON b.id = m.mailbox_id
           JOIN users u ON u.id = b.user_id
           WHERE b.user_id != ?
             AND m.date >= ?
             AND (lower(m.from_addr) = ? OR m.to_json LIKE ? OR m.cc_json LIKE ?)
           GROUP BY u.id
           HAVING sent_n > 0 OR recv_n > 0
           ORDER BY IFNULL(last_sent, 0) DESC, IFNULL(last_recv, 0) DESC
           LIMIT 5`
        )
        .all(a, a, userId, since, a, likeAddr, likeAddr);

  const threadPeers = threadId
    ? db
        .prepare(
          `SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email, MAX(m.date) AS last_at,
                  SUM(CASE WHEN m.from_addr = b.email THEN 1 ELSE 0 END) AS sent_n
           FROM messages m
           JOIN mailboxes b ON b.id = m.mailbox_id
           JOIN users u ON u.id = b.user_id
           WHERE b.user_id != ? AND m.thread_id = ? AND m.date >= ?
           GROUP BY u.id
           HAVING sent_n > 0
           ORDER BY last_at DESC
           LIMIT 3`
        )
        .all(userId, threadId, since)
    : [];

  if (!peers.length && !threadPeers.length) return null;

  const colleagues = peers.map((p) => {
    const parts = [];
    if (p.sent_n > 0) parts.push(`已发 ${p.sent_n} 封`);
    if (p.recv_n > 0) parts.push('也收到过');
    return {
      userId: p.user_id,
      name: p.user_name || p.user_email,
      email: p.user_email,
      lastSent: p.last_sent || null,
      lastRecv: p.last_recv || null,
      summary: parts.join(' · ') || '有往来',
      level: p.sent_n > 0 ? 'replied' : 'watching',
    };
  });

  const threadHits = threadPeers.map((p) => ({
    userId: p.user_id,
    name: p.user_name || p.user_email,
    email: p.user_email,
    lastAt: p.last_at,
    summary: '同一会话中已有回复',
    level: 'thread',
  }));

  const byId = new Map();
  for (const c of [...threadHits, ...colleagues]) {
    const prev = byId.get(c.userId);
    if (!prev || (c.level === 'thread' && prev.level !== 'thread') || (c.level === 'replied' && prev.level === 'watching')) {
      byId.set(c.userId, c);
    }
  }
  const list = [...byId.values()];
  const replied = list.filter((c) => c.level === 'replied' || c.level === 'thread');
  const scope = useDomain ? `同公司 @${d}` : a;
  const headName = replied[0]?.name || list[0]?.name || '同事';
  return {
    scope,
    count: list.length,
    severity: replied.length ? 'high' : 'medium',
    headline: replied.length
      ? `${headName}${replied.length > 1 ? ` 等 ${replied.length} 人` : ''}近期已与该买家互动，请先确认再回复`
      : `${list.length} 位同事也收到过${useDomain ? scope : '此发件人'}的邮件`,
    colleagues: list,
  };
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
  const recent = db
    .prepare(
      `SELECT m.subject, m.date FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE b.user_id = ? AND m.from_addr = ?
       ORDER BY m.date DESC LIMIT 3`
    )
    .all(userId, a)
    .map((r) => ({ subject: r.subject || '(无主题)', date: r.date }));
  const received = st?.received || 0;
  const sent = idx.wrote.get(a) || 0;
  const suggest = vipSuggestFor(idx, a, { received, sent, tier, rule });
  return {
    tier,
    rule: rule ? { key: rule.key, kind: rule.kind, name: rule.name } : null,
    company: companyOf(idx, { address: a }),
    received,
    sent,
    lastReceived: st?.last_received || null,
    lastSent: st?.last_sent || null,
    recentSubjects: recent,
    vipSuggest: suggest,
  };
}

// ---------- VIP 建议（不自动升 VIP，需一键确认） ----------
function vipSuggestFor(idx, address, { received = 0, sent = 0, tier, rule } = {}) {
  const a = String(address || '').toLowerCase();
  if (!a || rule?.kind === 'vip' || rule?.kind === 'muted') return null;
  if (['vip', 'muted', 'self', 'bulk', 'colleague'].includes(tier)) return null;
  if (ROBOT.test(a)) return null;
  const d = domainOf(a);
  const domainSent = d && !isFreeDomain(d) ? idx.wroteDomains.get(d) || 0 : 0;
  const score = sent * 3 + received + Math.min(domainSent, 8);
  const qualify = score >= 12 || (sent >= 3 && received >= 2) || (received >= 5 && sent >= 1);
  if (!qualify) return null;
  const reasons = [];
  if (sent >= 3) reasons.push(`你发过 ${sent} 封`);
  if (received >= 5) reasons.push(`来信 ${received} 封`);
  else if (received >= 2) reasons.push(`来信 ${received} 封`);
  if (tier === 'customer') reasons.push('已识别为老客户');
  if (domainSent >= 2 && !isFreeDomain(d)) reasons.push(`同公司往来 ${domainSent} 次`);
  if (!reasons.length) return null;
  const key = !isFreeDomain(d) && domainSent >= 2 ? '@' + d : a;
  return { key, address: a, score, reasons };
}

/** 扫描往来频次 + 订单/付款/投诉信号，给出 VIP 建议列表（不自动写入规则） */
export function vipSuggestions(userId, { limit = 15 } = {}) {
  const idx = relationIndex(userId);
  const rows = db
    .prepare(
      `SELECT lower(m.from_addr) AS addr,
              COUNT(*) AS received,
              SUM(CASE WHEN IFNULL(m.signals,'') LIKE '%order%' OR IFNULL(m.signals,'') LIKE '%payment%' OR IFNULL(m.signals,'') LIKE '%complaint%' THEN 1 ELSE 0 END) AS biz
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ? AND f.special_use = '\\Inbox' AND m.from_addr != b.email
         AND m.date >= ?
       GROUP BY lower(m.from_addr)
       HAVING received >= 2`
    )
    .all(userId, now() - 180 * DAY);

  const byKey = new Map();
  for (const r of rows) {
    const a = r.addr;
    const tier = tierOf(idx, a);
    const rule = ruleFor(idx, a);
    if (rule?.kind === 'vip' || rule?.kind === 'muted') continue;
    if (['vip', 'muted', 'self', 'bulk', 'colleague'].includes(tier)) continue;
    if (ROBOT.test(a)) continue;
    const sent = idx.wrote.get(a) || 0;
    const d = domainOf(a);
    const domainSent = d && !isFreeDomain(d) ? idx.wroteDomains.get(d) || 0 : 0;
    const score = sent * 3 + r.received + r.biz * 8 + Math.min(domainSent, 10);
    const qualify =
      score >= 12 || (sent >= 3 && r.received >= 2) || (r.biz >= 1 && (sent >= 2 || r.received >= 3)) || (r.received >= 5 && sent >= 1);
    if (!qualify) continue;
    const reasons = [];
    if (sent >= 3) reasons.push(`你发过 ${sent} 封`);
    if (r.received >= 5) reasons.push(`来信 ${r.received} 封`);
    else if (r.received >= 2) reasons.push(`来信 ${r.received} 封`);
    if (r.biz) reasons.push('含订单/付款/投诉往来');
    if (tier === 'customer') reasons.push('已识别为老客户');
    if (domainSent >= 2 && !isFreeDomain(d)) reasons.push(`同公司往来 ${domainSent} 次`);
    const key = !isFreeDomain(d) && domainSent >= 2 ? '@' + d : a;
    const company = companyOf(idx, { address: a });
    const prev = byKey.get(key);
    if (!prev || score > prev.score) {
      byKey.set(key, {
        key,
        address: a,
        name: company.name,
        domain: company.domain || null,
        score,
        reasons,
        sent,
        received: r.received,
        biz: r.biz,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
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

// ---------- 超时提醒（分阶段 + 冷却，替代一次性 reminded=1） ----------
const REMIND_MAX_STAGE = 3;
/** stage 完成后进入下一阶段前的冷却；stage0→1 立即 */
const REMIND_COOLDOWN = {
  0: 0,
  1: 4 * HOUR,
  2: 12 * HOUR,
  3: Infinity,
};

export function overdueToRemind(userId, settings) {
  const at = now();
  const data = focus(userId, settings);
  const fresh = data.reply.filter((m) => m.priority.overdue && m.priority.tier !== 'colleague');
  if (!fresh.length) return null;
  const ids = fresh.map((m) => m.id);
  const meta = new Map(
    db.prepare(`SELECT id, reminded, reminded_at FROM messages WHERE id IN (${ids.join(',')})`).all().map((r) => [r.id, r])
  );
  const due = [];
  for (const m of fresh) {
    const row = meta.get(m.id) || { reminded: 0, reminded_at: null };
    const stage = Number(row.reminded) || 0;
    if (stage >= REMIND_MAX_STAGE) continue;
    const last = Number(row.reminded_at) || 0;
    // 旧库 reminded=1 且无时间戳：补戳，本轮不重复推，避免升级风暴
    if (stage > 0 && !last) {
      db.prepare('UPDATE messages SET reminded_at = ? WHERE id = ?').run(at, m.id);
      continue;
    }
    const cool = REMIND_COOLDOWN[stage] ?? Infinity;
    if (stage > 0 && at - last < cool) continue;
    due.push({ m, nextStage: stage + 1 });
  }
  if (!due.length) return null;
  const upd = db.prepare('UPDATE messages SET reminded = ?, reminded_at = ? WHERE id = ?');
  for (const { m, nextStage } of due) upd.run(nextStage, at, m.id);
  const items = due.slice(0, 5).map(({ m, nextStage }) => ({
    id: m.id,
    subject: m.subject,
    from: m.from,
    stage: nextStage,
    waitingHours: m.priority.waitingHours,
    tier: m.priority.tier,
  }));
  return {
    count: due.length,
    total: data.stats.overdue,
    stage: Math.max(...due.map((d) => d.nextStage)),
    escalate: due.some((d) => d.nextStage >= 2),
    items,
  };
}
