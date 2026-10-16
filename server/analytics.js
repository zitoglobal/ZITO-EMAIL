import { db } from './db.js';
import { STAGES, stageMeta } from './deals.js';
import * as priority from './priority.js';
import * as users from './users.js';

/**
 * 团队销售轻报表：超时分层、认领分布、阶段管线、跟进到期
 */
export function teamInsights(viewerId, { dayStart } = {}) {
  const viewer = users.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(viewerId));
  const settings = viewer?.settings || {};
  const focus = priority.focus(viewerId, settings, { dayStart });

  const claimRows = db
    .prepare(
      `SELECT u.id, u.name, u.email, COUNT(*) AS n
       FROM deals d JOIN users u ON u.id = d.owner_user_id
       GROUP BY u.id ORDER BY n DESC`
    )
    .all()
    .map((r) => ({
      userId: r.id,
      name: r.name || r.email,
      email: r.email,
      count: r.n,
      mine: r.id === viewerId,
    }));

  const stageRows = db.prepare('SELECT stage, COUNT(*) AS n FROM deals GROUP BY stage').all();
  const stageMap = Object.fromEntries(stageRows.map((r) => [r.stage, r.n]));
  const stages = STAGES.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    count: stageMap[s.id] || 0,
  }));

  const now = Date.now();
  const DAY = 86400_000;
  const dueFollow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deals
       WHERE owner_user_id = ? AND next_follow_at IS NOT NULL AND next_follow_at <= ?`
    )
    .get(viewerId, now).n;
  const upcomingFollow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deals
       WHERE owner_user_id = ? AND next_follow_at IS NOT NULL AND next_follow_at > ? AND next_follow_at <= ?`
    )
    .get(viewerId, now, now + 7 * DAY).n;

  const stageAge = db
    .prepare(
      `SELECT stage, AVG(? - stage_updated_at) AS avg_ms, COUNT(*) AS n
       FROM deals WHERE owner_user_id = ? GROUP BY stage`
    )
    .all(now, viewerId)
    .map((r) => ({
      stage: r.stage,
      label: stageMeta(r.stage).label,
      avgDays: Math.round((Number(r.avg_ms) || 0) / DAY * 10) / 10,
      count: r.n,
    }));

  return {
    focus: {
      needReply: focus.stats?.needReply || 0,
      overdue: focus.stats?.overdue || 0,
      followups: focus.stats?.followups || 0,
      handledToday: focus.stats?.handledToday || 0,
      todayIn: focus.stats?.todayIn || 0,
    },
    overdueByTier: focus.overdueSummary?.byTier || { vip: 0, customer: 0, new: 0, other: 0 },
    overdueOldestHours: focus.overdueSummary?.oldestHours || 0,
    claimsByUser: claimRows,
    myClaims: claimRows.find((c) => c.mine)?.count || 0,
    stages,
    stageAge,
    follow: { due: dueFollow, upcoming7d: upcomingFollow },
    generatedAt: now,
  };
}
