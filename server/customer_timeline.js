/**
 * 客户时间线：把往来邮件 + 认领/阶段事件 + 当前决策收成一面
 */
import { db } from './db.js';
import * as deals from './deals.js';
import { domainOf, isFreeDomain, suggestFollowAction } from './priority_timeline_helpers.js';

const HOUR = 3600_000;

function normAddr(a) {
  return String(a || '')
    .trim()
    .toLowerCase();
}

function ownEmails(userId) {
  return new Set(db.prepare('SELECT lower(email) e FROM mailboxes WHERE user_id = ?').all(userId).map((r) => r.e));
}

/** 双向最近邮件（Inbox + Sent），排除垃圾/废纸篓 */
function recentThread(userId, address, limit = 16) {
  const addr = normAddr(address);
  if (!addr) return [];
  const lim = Math.min(40, Math.max(4, Number(limit) || 16));
  const own = ownEmails(userId);
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.snippet, m.date, m.from_addr, m.to_json, m.message_id,
              f.special_use, b.email AS mb_email
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE b.user_id = ?
         AND IFNULL(f.special_use, '') NOT IN ('\\Trash', '\\Junk', '\\Drafts')
         AND (
           lower(m.from_addr) = ?
           OR lower(m.to_json) LIKE ?
         )
       ORDER BY m.date DESC
       LIMIT ?`
    )
    .all(userId, addr, `%${addr}%`, lim);

  return rows.map((r) => {
    const fromMe =
      own.has(String(r.from_addr || '').toLowerCase()) ||
      String(r.mb_email || '').toLowerCase() === String(r.from_addr || '').toLowerCase() ||
      r.special_use === '\\Sent';
    const direction = fromMe ? 'out' : 'in';
    return {
      type: 'mail',
      id: r.id,
      direction,
      subject: r.subject || '(无主题)',
      snippet: (r.snippet || '').slice(0, 160),
      date: r.date,
      fromAddr: r.from_addr,
      specialUse: r.special_use || null,
    };
  });
}

/** @visibleForTesting */
export function computeDecision(userId, address, mails, deal) {
  const addr = normAddr(address);
  const own = ownEmails(userId);
  const at = Date.now();
  let lastIn = null;
  let lastOut = null;
  for (const m of mails) {
    if (m.direction === 'in' && (!lastIn || m.date > lastIn.date)) lastIn = m;
    if (m.direction === 'out' && (!lastOut || m.date > lastOut.date)) lastOut = m;
  }

  let status = 'idle';
  let waitingHours = 0;
  let urgency = 'soft';
  let due = false;
  let why = '暂无足够往来';

  if (lastOut && (!lastIn || lastOut.date > lastIn.date)) {
    status = 'waiting_them';
    waitingHours = Math.round(((at - lastOut.date) / HOUR) * 10) / 10;
    due = waitingHours >= 72;
    urgency = due ? 'due' : waitingHours >= 24 ? 'due' : 'soft';
    why = `你最后发出于 ${new Date(lastOut.date).toLocaleString('zh-CN')}，对方尚未回复`;
  } else if (lastIn && (!lastOut || lastIn.date > lastOut.date)) {
    // 对方最后来信：若来自对方地址，待你回
    const fromThem = normAddr(lastIn.fromAddr) === addr || !own.has(normAddr(lastIn.fromAddr));
    if (fromThem) {
      status = 'need_reply';
      waitingHours = Math.round(((at - lastIn.date) / HOUR) * 10) / 10;
      due = waitingHours >= 24;
      urgency = due ? 'due' : 'soft';
      why = `对方最后来信于 ${new Date(lastIn.date).toLocaleString('zh-CN')}，等待你回复`;
    }
  }

  if (deal?.nextFollowAt && deal.nextFollowAt <= at) {
    status = status === 'need_reply' ? status : 'follow_due';
    due = true;
    urgency = 'due';
    why = (why === '暂无足够往来' ? '' : why + ' · ') + '跟进日已到期';
  }

  const suggestedAction =
    status === 'waiting_them'
      ? suggestFollowAction({
          urgency,
          due,
          waitingHours,
          tier: deal?.tier || 'customer',
          signals: [],
        })
      : status === 'need_reply'
        ? {
            code: due ? 'reply_now' : 'reply',
            label: due ? '尽快回复' : '回复对方',
            detail: due ? '已超过一天未回对方' : '对方在等你的回复',
          }
        : status === 'follow_due'
          ? { code: 'nudge', label: '写跟进', detail: '跟进日到期' }
          : { code: 'idle', label: '暂无紧急动作', detail: '可浏览时间线或更新备注' };

  return {
    status,
    waitingHours,
    urgency,
    due,
    why,
    suggestedAction,
    lastInAt: lastIn?.date || null,
    lastOutAt: lastOut?.date || null,
    lastInId: lastIn?.id || null,
    lastOutId: lastOut?.id || null,
  };
}

/**
 * @param {number} userId
 * @param {string} address 对方邮箱
 */
export function buildCustomerTimeline(userId, address, { limit = 16 } = {}) {
  const addr = normAddr(address);
  if (!addr || !addr.includes('@')) {
    throw Object.assign(new Error('请提供有效客户邮箱'), { status: 400 });
  }

  const lookup = deals.lookup(userId, { address: addr });
  const deal = lookup.deal;
  const events = deals.listEvents(userId, { address: addr, dealId: deal?.id, limit: 20 }).map((e) => ({
    type: 'deal_event',
    id: 'ev-' + e.id,
    action: e.action,
    detail: e.detail,
    date: e.at,
    actor: e.actor,
  }));

  const mails = recentThread(userId, addr, limit);
  const decision = computeDecision(userId, addr, mails, deal);

  // 合并时间线：邮件 + 事件，按时间倒序
  const items = [...mails, ...events]
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, Math.min(36, Number(limit) + 12));

  const d = domainOf(addr);
  return {
    address: addr,
    companyDomain: d && !isFreeDomain(d) ? d : null,
    decision,
    deal,
    scope: lookup.scope,
    canClaimPerson: !!lookup.canClaimPerson,
    canSplit: !!lookup.canSplit,
    stages: lookup.stages || deals.STAGES,
    items,
    stats: {
      mailCount: mails.length,
      inCount: mails.filter((m) => m.direction === 'in').length,
      outCount: mails.filter((m) => m.direction === 'out').length,
      eventCount: events.length,
    },
  };
}
