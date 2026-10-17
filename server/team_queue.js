/**
 * 团队公海：跨成员未认领的客户来信（元数据 + 认领/指派，不跨账号读正文）。
 */
import { db } from './db.js';
import { resolveScopes } from './deals.js';
import { isFreeDomain, domainOf, slaFor } from './priority.js';
import { signalsOf } from './classify.js';
import * as users from './users.js';

/** 公海超时：默认用首位管理员 SLA，避免「因查看者设置而不同」；管理员可设 teamQueueSla=viewer 回退 */
function slaSettingsForQueue(viewerId) {
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`).get();
  if (admin) {
    const settings = users.settingsOf(admin.id);
    if (settings.teamQueueSla !== 'viewer') {
      return { settings, source: 'team' };
    }
  }
  return { settings: users.settingsOf(viewerId), source: 'viewer' };
}

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

export function queueScore(item) {
  let s = 0;
  if (item.vip) s += 100;
  if (item.overdue) s += 55;
  s += Math.min(40, item.waitingHours || 0);
  const sig = item.signals || [];
  if (sig.includes('urgent') || sig.includes('complaint')) s += 22;
  if (sig.includes('order') || sig.includes('payment')) s += 16;
  if (sig.includes('inquiry') || sig.includes('sample') || sig.includes('fabric') || sig.includes('fit')) s += 10;
  return Math.round(s);
}

/** 公海超时未认领摘要（催办用） */
export function overdueSummary() {
  const data = listQueue(0, { limit: 120 });
  const overdue = data.items.filter((x) => x.overdue);
  if (!overdue.length) return null;
  const oldest = overdue.reduce((a, b) => (a.waitingHours >= b.waitingHours ? a : b));
  return {
    count: overdue.length,
    vip: overdue.filter((x) => x.vip).length,
    oldestHours: oldest.waitingHours,
    sample: overdue.slice(0, 3).map((x) => ({
      scopeLabel: x.scopeLabel,
      from: x.from,
      subject: x.subject,
      waitingHours: x.waitingHours,
      vip: x.vip,
    })),
  };
}

/** 管理员催办冷却（内存） */
const adminRemindAt = new Map();
const ADMIN_REMIND_COOLDOWN = 2 * 3600_000;

export function remindAdmins({ emit, push, isOnline }) {
  const snap = overdueSummary();
  if (!snap) return;
  const admins = db.prepare(`SELECT id, name, email FROM users WHERE role = 'admin'`).all();
  const t = Date.now();
  for (const a of admins) {
    const last = adminRemindAt.get(a.id) || 0;
    if (t - last < ADMIN_REMIND_COOLDOWN) continue;
    adminRemindAt.set(a.id, t);
    const payload = {
      type: 'team-queue',
      count: snap.count,
      vip: snap.vip,
      oldestHours: snap.oldestHours,
      sample: snap.sample,
      subject: `公海 ${snap.count} 条超时未认领`,
    };
    if (isOnline?.(a.id)) emit(a.id, 'remind-queue', payload);
    push
      ?.notifyUser?.(a.id, {
        title: '团队公海待认领',
        body: `${snap.count} 条已超时${snap.vip ? `（含 ${snap.vip} VIP）` : ''}，最早已等 ${snap.oldestHours}h`,
        url: '/?box=team',
        tag: 'zm-team-queue',
      })
      .catch?.(() => {});
  }
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
  const { settings, source: slaSource } = slaSettingsForQueue(viewerId);

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
    const scopes = resolveScopes(r.from_addr);
    if (!scopes) continue;
    // 个人认领或公司域认领任一命中则不再进公海
    if (claimed.has(scopes.person.key)) continue;
    if (scopes.company && claimed.has(scopes.company.key)) continue;
    const scope = scopes.default;
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
    const mine = r.owner_user_id === viewerId;
    const item = {
      id: r.id,
      subject: r.subject,
      // 同事箱不回传正文预览，避免公海跨账号泄露业务摘要
      snippet: mine ? r.snippet || '' : '',
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
      mine,
      canOpen: mine,
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
    slaSource,
    canAssign: viewer?.role === 'admin',
    generatedAt: at,
  };
}

/** 侧栏角标：带短缓存，避免每次 /state 全量扫公海 */
const statsCache = new Map();
const STATS_TTL = 45_000;

export function invalidateQueueStatsCache() {
  statsCache.clear();
}

export function queueStats(viewerId) {
  const id = Number(viewerId) || 0;
  const hit = statsCache.get(id);
  const t = Date.now();
  if (hit && t - hit.at < STATS_TTL) return hit.stats;
  const data = listQueue(id, { limit: 80 });
  const stats = {
    total: data.stats.total,
    overdue: data.stats.overdue,
    vip: data.stats.vip,
    mine: data.stats.mine,
    others: data.stats.others,
  };
  statsCache.set(id, { at: t, stats });
  return stats;
}
