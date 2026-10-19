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

  const since = now - 30 * DAY;
  const funnelOrder = ['inquiry', 'quote', 'sample', 'bulk', 'payment', 'won', 'lost'];
  const funnelCounts = Object.fromEntries(funnelOrder.map((id) => [id, stageMap[id] || 0]));
  const stageEvents = db
    .prepare(
      `SELECT detail, COUNT(*) AS n FROM deal_events
       WHERE action = 'stage' AND created_at >= ?
       GROUP BY detail ORDER BY n DESC LIMIT 40`
    )
    .all(since);
  const transitions = { toQuote: 0, toSample: 0, toBulk: 0, toWon: 0, toLost: 0 };
  for (const e of stageEvents) {
    const d = String(e.detail || '');
    if (/→\s*报价/.test(d)) transitions.toQuote += e.n;
    if (/→\s*样品/.test(d)) transitions.toSample += e.n;
    if (/→\s*大货/.test(d)) transitions.toBulk += e.n;
    if (/→\s*成交/.test(d)) transitions.toWon += e.n;
    if (/→\s*丢单/.test(d)) transitions.toLost += e.n;
  }

  /** 轻量 cohort：近 30 日阶段事件中「A → B」次数与相邻转化率（非完整漏斗归因） */
  const pairRows = db
    .prepare(
      `SELECT detail, COUNT(*) AS n FROM deal_events
       WHERE action = 'stage' AND created_at >= ? AND detail LIKE '%→%'
       GROUP BY detail`
    )
    .all(since);
  let inquiryToQuote = 0;
  let quoteToSample = 0;
  let sampleToBulk = 0;
  for (const e of pairRows) {
    const d = String(e.detail || '');
    if (/询盘\s*→\s*报价/.test(d)) inquiryToQuote += e.n;
    if (/报价\s*→\s*样品/.test(d)) quoteToSample += e.n;
    if (/样品\s*→\s*大货/.test(d)) sampleToBulk += e.n;
  }
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  const cohort30d = {
    inquiryToQuote,
    quoteToSample,
    sampleToBulk,
    /** 进入报价 /（存量询盘 + 进入报价） */
    inquiryToQuoteRate: pct(inquiryToQuote, (funnelCounts.inquiry || 0) + inquiryToQuote),
    quoteToSampleRate: pct(quoteToSample, (funnelCounts.quote || 0) + quoteToSample),
    sampleToBulkRate: pct(sampleToBulk, (funnelCounts.sample || 0) + sampleToBulk),
  };

  const openPipe = (funnelCounts.inquiry || 0) + (funnelCounts.quote || 0) + (funnelCounts.sample || 0) + (funnelCounts.bulk || 0) + (funnelCounts.payment || 0);
  const wonRate = openPipe + (funnelCounts.won || 0) + (funnelCounts.lost || 0)
    ? Math.round(((funnelCounts.won || 0) / Math.max(1, (funnelCounts.won || 0) + (funnelCounts.lost || 0) + openPipe)) * 1000) / 10
    : 0;

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
    funnel: {
      counts: funnelCounts,
      stages: STAGES.map((s) => ({ id: s.id, label: s.label, color: s.color, count: funnelCounts[s.id] || 0 })),
      transitions30d: transitions,
      cohort30d,
      wonRate,
      openPipeline: openPipe,
    },
    generatedAt: now,
  };
}
