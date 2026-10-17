/**
 * 团队公海：跨成员未认领的客户来信（元数据 + 认领，不跨账号读正文）。
 */
import { db } from './db.js';
import { scopeFromAddress } from './deals.js';
import { isFreeDomain, domainOf } from './priority.js';

const DAY = 86400_000;
const WINDOW = 21 * DAY;

function claimedKeys() {
  return new Set(db.prepare('SELECT scope_key FROM deals').all().map((r) => r.scope_key));
}

/**
 * @param {number} viewerId
 * @param {{ limit?: number }} [opts]
 */
export function listQueue(viewerId, { limit = 60 } = {}) {
  const at = Date.now();
  const claimed = claimedKeys();
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.from_name, m.from_addr, m.date, m.snippet, m.thread_id, m.message_id,
              m.category, m.answered, m.done_at, m.snooze_until,
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
    // 过滤明显群发/机器人已在 scopeFromAddress；同事同域不进公海
    if (d && !isFreeDomain(d)) {
      const ownerDomain = domainOf(r.mailbox_email);
      if (ownerDomain && ownerDomain === d) continue;
    }
    const prev = byScope.get(scope.key);
    if (!prev || r.date < prev.date) {
      byScope.set(scope.key, {
        id: r.id,
        subject: r.subject,
        snippet: r.snippet,
        from: { name: r.from_name, address: r.from_addr },
        date: r.date,
        threadId: r.thread_id,
        waitingHours: Math.round(((at - r.date) / 3600_000) * 10) / 10,
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
      });
    }
  }

  const items = [...byScope.values()]
    .sort((a, b) => a.date - b.date)
    .slice(0, Math.min(120, Math.max(1, Number(limit) || 60)));

  return {
    items,
    stats: {
      total: items.length,
      mine: items.filter((x) => x.mine).length,
      others: items.filter((x) => !x.mine).length,
    },
    generatedAt: at,
  };
}
