/**
 * 团队公海：跨成员未认领的客户来信（元数据 + 认领/指派，不跨账号读正文）。
 */
import { db } from './db.js';
import { scopeFromAddress } from './deals.js';
import { isFreeDomain, domainOf, slaFor } from './priority.js';
import { signalsOf } from './classify.js';
import * as users from './users.js';

const DAY = 86400_000;
const WINDOW = 21 * DAY;
const HOUR = 3600_000;

function claimedKeys() {
  return new Set(db.prepare('SELECT scope_key FROM deals').all().map((r) => r.scope_key));
}

function teamVipKeys() {
  return new Set(
    db
      .prepare(`SELECT LOWER(key) AS k FROM sender_rules WHERE kind = 'vip'`)
      .all()
      .map((r) => r.k)
      .filter(Boolean)
  );
}

function isTeamVip(addr, vipKeys) {
  const a = String(addr || '').toLowerCase();
  if (!a || !vipKeys.size) return false;
  if (vipKeys.has(a)) return true;
  const d = domainOf(a);
  return !!(d && (vipKeys.has('@' + d) || vipKeys.has(d)));
}

function queueScore(item) {
  let s = 0;
  if (item.vip) s += 100;
  if (item.overdue) s += 55;
  s += Math.min(40, item.waitingHours || 0);
  const sig = item.signals || [];
  if (sig.includes('urgent') || sig.includes('complaint')) s += 22;
  if (sig.includes('order') || sig.includes('payment')) s += 16;
  if (sig.includes('inquiry') || sig.includes('sample')) s += 10;
  return Math.round(s);
}

/**
 * @param {number} viewerId
 * @param {{ limit?: number }} [opts]
 */
export function listQueue(viewerId, { limit = 60 } = {}) {
  const at = Date.now();
  const claimed = claimedKeys();
  const vipKeys = teamVipKeys();
  const viewer = users.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(viewerId));
  const settings = viewer?.settings || {};

  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.from_name, m.from_addr, m.date, m.snippet, m.thread_id, m.message_id,
              m.category, m.answered, m.done_at, m.snooze_until, m.signals,
              b.id AS mailbox_id, b.email AS mailbox_email, b.user_id AS owner_user_id,
              u.name AS owner_name, u.email AS owner_email
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       JOIN users u ON u.id = b.user_id
       LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.path = m.folder
       WHERE f.special_use = '\\Inbox'
         AND IFNULL(m.answered, 0) = 0
         AND m.done_at IS NULL
         AND (m.snooze_until IS NULL OR m.snooze_until <= ?)
         AND m.date >= ?
         AND IFNULL(m.category, 'people') = 'people'
       ORDER BY m.date ASC
       LIMIT 400`
    )
    .all(at, at - WINDOW);

  const byScope = new Map();
  for (const r of rows) {
    const scope = scopeFromAddress(r.from_addr);
    if (!scope) continue;
    if (claimed.has(scope.key)) continue;
    const d = domainOf(r.from_addr);
    if (d && !isFreeDomain(d)) {
      const ownerDomain = domainOf(r.mailbox_email);
      if (ownerDomain && ownerDomain === d) continue;
    }
    const prev = byScope.get(scope.key);
    if (prev && r.date >= prev.date) continue;

    const vip = isTeamVip(r.from_addr, vipKeys);
    const signals = r.signals != null ? (r.signals ? String(r.signals).split(',') : []) : signalsOf(r.subject, r.snippet);
    const tier = vip ? 'vip' : 'new';
    const slaHours = slaFor(settings, tier, signals);
    const waitingHours = Math.round(((at - r.date) / HOUR) * 10) / 10;
    const overdue = waitingHours >= slaHours;
    const item = {
      id: r.id,
      subject: r.subject,
      snippet: r.snippet,
      from: { name: r.from_name, address: r.from_addr },
      date: r.date,
      threadId: r.thread_id,
      waitingHours,
      slaHours,
      overdue,
      vip,
      signals: signals.filter(Boolean).slice(0, 6),
      scopeKey: scope.key,
      scopeKind: scope.kind,
      scopeLabel: scope.label,
      owner: {
        id: r.owner_user_id,
        name: r.owner_name || r.owner_email,
        mailbox: r.mailbox_email,
      },
      mine: r.owner_user_id === viewerId,
      canOpen: r.owner_user_id === viewerId,
    };
    item.score = queueScore(item);
    byScope.set(scope.key, item);
  }

  const items = [...byScope.values()]
    .sort((a, b) => b.score - a.score || a.date - b.date)
    .slice(0, Math.min(120, Math.max(1, Number(limit) || 60)));

  return {
    items,
    stats: {
      total: items.length,
      mine: items.filter((x) => x.mine).length,
      others: items.filter((x) => !x.mine).length,
      overdue: items.filter((x) => x.overdue).length,
      vip: items.filter((x) => x.vip).length,
    },
    canAssign: viewer?.role === 'admin',
    generatedAt: at,
  };
}
