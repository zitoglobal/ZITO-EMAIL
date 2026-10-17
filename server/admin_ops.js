/**
 * 管理员轻量可观测性：在线、同步失败、Focus 抽样、OAuth 配置态。
 */
import { db } from './db.js';
import { onlineUserCount } from './events.js';
import * as oauth from './oauth.js';
import * as priority from './priority.js';
import * as users from './users.js';
import * as ai from './ai.js';
import * as backup from './backup.js';

export function snapshot(viewerId) {
  const now = Date.now();
  const DAY = 86400_000;
  const errorMailboxes = db
    .prepare(
      `SELECT b.id, b.email, b.status, b.last_error, b.last_sync, u.name AS user_name, u.email AS user_email
       FROM mailboxes b JOIN users u ON u.id = b.user_id
       WHERE b.status = 'error'
       ORDER BY b.last_sync DESC LIMIT 40`
    )
    .all()
    .map((r) => ({
      id: r.id,
      email: r.email,
      error: r.last_error,
      lastSync: r.last_sync,
      user: r.user_name || r.user_email,
    }));

  // SQLite 无 NULLS LAST：再按 JS 排一次
  errorMailboxes.sort((a, b) => (b.lastSync || 0) - (a.lastSync || 0));

  const mailboxStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
         SUM(CASE WHEN status = 'syncing' THEN 1 ELSE 0 END) AS syncing,
         SUM(CASE WHEN oauth_refresh_enc IS NOT NULL OR oauth_access_enc IS NOT NULL THEN 1 ELSE 0 END) AS oauth
       FROM mailboxes`
    )
    .get();

  const userCount = users.userCount();
  const viewer = users.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(viewerId));
  const focus = viewer ? priority.focus(viewerId, viewer.settings || {}) : null;
  const sampleOut = [];
  // 抽样：取待办前 3 + 等待前 2 的 why，便于肉眼验真
  for (const m of (focus?.reply || []).slice(0, 3)) {
    sampleOut.push({
      id: m.id,
      section: 'reply',
      subject: m.subject,
      from: m.from?.address || m.from_addr,
      why: m.priority?.why || '',
      overdue: !!m.priority?.overdue,
    });
  }
  for (const m of (focus?.followups || []).slice(0, 2)) {
    sampleOut.push({
      id: m.id,
      section: 'follow',
      subject: m.subject,
      from: m.from?.address || m.to?.[0]?.address,
      why: m.follow?.why || '',
    });
  }

  const dealsOpen = db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('won','lost')`).get().n;
  const claimsToday = db
    .prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE created_at >= ? AND action IN ('claim','takeover')`)
    .get(now - DAY).n;

  const mailSecret = String(process.env.MAIL_SECRET || '').trim();

  return {
    onlineUsers: onlineUserCount(),
    users: userCount,
    mailboxes: {
      total: mailboxStats.total || 0,
      ok: mailboxStats.ok || 0,
      error: mailboxStats.error || 0,
      syncing: mailboxStats.syncing || 0,
      oauth: mailboxStats.oauth || 0,
    },
    errorMailboxes: errorMailboxes.slice(0, 20),
    oauthProviders: oauth.status(),
    aiConfigured: ai.aiConfigured(),
    mailSecretConfigured: !!(mailSecret && mailSecret !== 'change-me-to-a-long-random-string'),
    lastBackupAt: backup.lastBackupAt(),
    focusSample: sampleOut,
    focusStats: focus?.stats
      ? {
          needReply: focus.stats.needReply || 0,
          overdue: focus.stats.overdue || 0,
          followups: focus.stats.followups || 0,
        }
      : null,
    dealsOpen,
    claimsToday,
    uptime: Math.round(process.uptime()),
    generatedAt: now,
  };
}
