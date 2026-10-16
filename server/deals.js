import { db, now } from './db.js';

/** 避免与 priority.js 循环依赖：域名工具在此内联一份 */
const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.jp', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.ru', 'yandex.ru', 'yandex.com',
  'naver.com', 'hanmail.net', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com',
  '189.cn', 'tom.com', 'ethereal.email',
]);
const domainOf = (a) => String(a || '').toLowerCase().split('@')[1] || '';
const isFreeDomain = (d) => FREE_DOMAINS.has(d);

/** 外贸销售阶段（落在邮箱内，不依赖已下线的独立 CRM） */
export const STAGES = [
  { id: 'inquiry', label: '询盘', color: '#0a66ff' },
  { id: 'quote', label: '报价中', color: '#7c3aed' },
  { id: 'sample', label: '样品', color: '#0d9488' },
  { id: 'bulk', label: '大货', color: '#16a34a' },
  { id: 'payment', label: '付款', color: '#ca8a04' },
  { id: 'won', label: '成交', color: '#11653b' },
  { id: 'lost', label: '丢单', color: '#9f2a2a' },
];

const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const ROBOT = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?@|bounce)/i;

export function stageMeta(id) {
  return STAGES.find((s) => s.id === id) || STAGES[0];
}

export function isValidStage(id) {
  return STAGE_IDS.has(String(id || ''));
}

/** 从发件人解析团队共享的认领键：企业域优先，公共邮箱按个人 */
export function scopeFromAddress(address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a || !a.includes('@') || ROBOT.test(a)) return null;
  const d = domainOf(a);
  if (d && !isFreeDomain(d)) return { key: 'c:@' + d, kind: 'company', label: '@' + d, address: a };
  return { key: 'a:' + a, kind: 'address', label: a, address: a };
}

function userRow(id) {
  return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);
}

function publicDeal(row, viewerId) {
  if (!row) return null;
  const owner = userRow(row.owner_user_id);
  const stage = stageMeta(row.stage);
  return {
    id: row.id,
    scopeKey: row.scope_key,
    scopeKind: row.scope_kind,
    scopeLabel: row.scope_key.startsWith('c:') ? row.scope_key.slice(2) : row.scope_key.slice(2),
    stage: stage.id,
    stageLabel: stage.label,
    stageColor: stage.color,
    note: row.note || '',
    claimedAt: row.claimed_at,
    stageUpdatedAt: row.stage_updated_at,
    nextFollowAt: row.next_follow_at || null,
    lastThreadId: row.last_thread_id || null,
    lastAddress: row.last_address || null,
    owner: owner
      ? { id: owner.id, name: owner.name || owner.email, email: owner.email, role: owner.role }
      : { id: row.owner_user_id, name: '未知同事', email: '', role: 'member' },
    mine: row.owner_user_id === viewerId,
    canRelease: row.owner_user_id === viewerId || userRow(viewerId)?.role === 'admin',
    canTakeover: row.owner_user_id !== viewerId && userRow(viewerId)?.role === 'admin',
  };
}

function logEvent(dealId, scopeKey, actorUserId, action, detail = '') {
  db.prepare(
    `INSERT INTO deal_events (deal_id, scope_key, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(dealId || null, scopeKey, actorUserId, action, String(detail || '').slice(0, 200), now());
}

/** 最近认领/阶段变更（按 scope 或 deal） */
export function listEvents(viewerId, { dealId, address, limit = 12 } = {}) {
  void viewerId;
  let scopeKey = null;
  if (dealId) {
    const row = getDealById(dealId);
    if (row) scopeKey = row.scope_key;
  }
  if (!scopeKey && address) {
    const scope = scopeFromAddress(address);
    if (scope) scopeKey = scope.key;
  }
  if (!scopeKey) return [];
  const lim = Math.min(40, Math.max(1, Number(limit) || 12));
  const rows = db
    .prepare(
      `SELECT id, deal_id, scope_key, actor_user_id, action, detail, created_at
       FROM deal_events WHERE scope_key = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(scopeKey, lim);
  return rows.map((r) => {
    const actor = userRow(r.actor_user_id);
    return {
      id: r.id,
      dealId: r.deal_id,
      action: r.action,
      detail: r.detail || '',
      at: r.created_at,
      actor: actor
        ? { id: actor.id, name: actor.name || actor.email }
        : { id: r.actor_user_id, name: '未知同事' },
    };
  });
}

export function getDealById(id) {
  return db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
}

export function lookup(viewerId, { address, threadId } = {}) {
  const scope = scopeFromAddress(address);
  if (!scope) return { deal: null, scope: null, stages: STAGES };
  const row = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scope.key);
  let deal = publicDeal(row, viewerId);
  // 若带 threadId 且当前无 deal，不自动创建；仅回填 last_thread 供展示
  if (deal && threadId && deal.lastThreadId !== threadId) {
    /* read-only lookup — no write */
  }
  return { deal, scope: { key: scope.key, kind: scope.kind, label: scope.label }, stages: STAGES };
}

/**
 * 认领客户。他人已认领时默认 409；admin 或 force=true 可接管。
 */
export function claim(userId, { address, threadId, note, force = false } = {}) {
  const scope = scopeFromAddress(address);
  if (!scope) throw Object.assign(new Error('无法认领：发件人地址无效'), { status: 400 });
  const user = userRow(userId);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 401 });
  const t = now();
  const existing = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scope.key);

  if (existing && existing.owner_user_id !== userId) {
    const allow = force && user.role === 'admin';
    if (!allow) {
      const deal = publicDeal(existing, userId);
      const err = Object.assign(new Error(`${deal.owner.name} 已认领 ${deal.scopeLabel}，请先沟通或请管理员接管`), {
        status: 409,
        deal,
      });
      throw err;
    }
    const prev = userRow(existing.owner_user_id);
    db.prepare(
      `UPDATE deals SET owner_user_id = ?, claimed_at = ?, note = CASE WHEN ? != '' THEN ? ELSE note END,
        last_thread_id = COALESCE(?, last_thread_id), last_address = ?, updated_at = ?
       WHERE id = ?`
    ).run(userId, t, String(note || '').trim(), String(note || '').trim().slice(0, 200), threadId || null, scope.address, t, existing.id);
    logEvent(existing.id, scope.key, userId, 'takeover', `从 ${prev?.name || prev?.email || '同事'} 接管`);
    return publicDeal(getDealById(existing.id), userId);
  }

  if (existing) {
    db.prepare(
      `UPDATE deals SET claimed_at = ?, note = CASE WHEN ? != '' THEN ? ELSE note END,
        last_thread_id = COALESCE(?, last_thread_id), last_address = ?, updated_at = ?
       WHERE id = ?`
    ).run(t, String(note || '').trim(), String(note || '').trim().slice(0, 200), threadId || null, scope.address, t, existing.id);
    logEvent(existing.id, scope.key, userId, 'claim', '重新确认认领');
    return publicDeal(getDealById(existing.id), userId);
  }

  const info = db
    .prepare(
      `INSERT INTO deals
        (scope_key, scope_kind, owner_user_id, claimed_at, stage, stage_updated_at, note, last_thread_id, last_address, updated_at)
       VALUES (?, ?, ?, ?, 'inquiry', ?, ?, ?, ?, ?)`
    )
    .run(
      scope.key,
      scope.kind,
      userId,
      t,
      t,
      String(note || '').trim().slice(0, 200),
      threadId || null,
      scope.address,
      t
    );
  const newId = Number(info.lastInsertRowid);
  logEvent(newId, scope.key, userId, 'claim', '认领客户');
  return publicDeal(getDealById(newId), userId);
}

export function release(userId, dealId) {
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  const user = userRow(userId);
  if (row.owner_user_id !== userId && user?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以释放'), { status: 403 });
  }
  logEvent(row.id, row.scope_key, userId, 'release', userId === row.owner_user_id ? '释放认领' : '管理员释放认领');
  db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);
  return { ok: true };
}

export function setStage(userId, dealId, stage) {
  if (!isValidStage(stage)) throw Object.assign(new Error('无效的业务阶段'), { status: 400 });
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  if (row.owner_user_id !== userId && userRow(userId)?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以改阶段'), { status: 403 });
  }
  const t = now();
  const from = stageMeta(row.stage).label;
  const to = stageMeta(stage).label;
  db.prepare('UPDATE deals SET stage = ?, stage_updated_at = ?, updated_at = ? WHERE id = ?').run(stage, t, t, dealId);
  if (row.stage !== stage) logEvent(dealId, row.scope_key, userId, 'stage', `${from} → ${to}`);
  return publicDeal(getDealById(dealId), userId);
}

export function setNote(userId, dealId, note) {
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  if (row.owner_user_id !== userId && userRow(userId)?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以改备注'), { status: 403 });
  }
  const t = now();
  db.prepare('UPDATE deals SET note = ?, updated_at = ? WHERE id = ?').run(String(note || '').trim().slice(0, 200), t, dealId);
  return publicDeal(getDealById(dealId), userId);
}

/** nextFollowAt: 时间戳毫秒，或 null/'' 清除 */
export function setNextFollowAt(userId, dealId, nextFollowAt) {
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  if (row.owner_user_id !== userId && userRow(userId)?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以设跟进日'), { status: 403 });
  }
  let ts = null;
  if (nextFollowAt != null && nextFollowAt !== '') {
    ts = Number(nextFollowAt);
    if (!Number.isFinite(ts)) throw Object.assign(new Error('无效的跟进日期'), { status: 400 });
  }
  const t = now();
  db.prepare('UPDATE deals SET next_follow_at = ?, updated_at = ? WHERE id = ?').run(ts, t, dealId);
  if (ts) logEvent(dealId, row.scope_key, userId, 'follow', `下次跟进 ${new Date(ts).toLocaleDateString('zh-CN')}`);
  return publicDeal(getDealById(dealId), userId);
}

/** 我认领且跟进日已到期的客户（Focus「等待」注入用） */
export function dueFollowDeals(userId, at = Date.now()) {
  const rows = db
    .prepare(
      `SELECT * FROM deals
       WHERE owner_user_id = ? AND next_follow_at IS NOT NULL AND next_follow_at <= ?
       ORDER BY next_follow_at ASC LIMIT 80`
    )
    .all(userId, at);
  return rows.map((r) => publicDeal(r, userId));
}

/**
 * 处理完待跟进后滚到下一次：next_follow_at = now + followDays。
 * onlyDue：仅滚动已到期的跟进日（「无需回复」用）；nofollow 可滚未到期的。
 */
export function rollFollowAfterHandled(userId, messageRows = [], { days = 3, onlyDue = false } = {}) {
  const dayMs = Math.max(1, Number(days) || 3) * 24 * 3600 * 1000;
  const at = now();
  const nextAt = at + dayMs;
  const rolled = [];
  const seen = new Set();
  for (const r of messageRows) {
    let addr = '';
    try {
      const to = JSON.parse(r.to_json || '[]');
      const cc = JSON.parse(r.cc_json || '[]');
      const own = String(r.from_addr || '').toLowerCase();
      const pick = [...to, ...cc].find((a) => {
        const x = String(a?.address || '').toLowerCase();
        return x && x !== own && scopeFromAddress(x);
      });
      addr = pick?.address || r.from_addr || '';
    } catch {
      addr = r.from_addr || '';
    }
    const scope = scopeFromAddress(addr);
    if (!scope || seen.has(scope.key)) continue;
    seen.add(scope.key);
    const row = db.prepare('SELECT * FROM deals WHERE scope_key = ? AND owner_user_id = ?').get(scope.key, userId);
    if (!row) continue;
    // 仅当已设跟进日时滚动；从未设过的不自动开跟进日
    if (row.next_follow_at == null) continue;
    if (onlyDue && row.next_follow_at > at) continue;
    db.prepare('UPDATE deals SET next_follow_at = ?, updated_at = ? WHERE id = ?').run(nextAt, at, row.id);
    logEvent(row.id, row.scope_key, userId, 'follow', `处理后续跟进 ${new Date(nextAt).toLocaleDateString('zh-CN')}`);
    rolled.push(publicDeal(getDealById(row.id), userId));
  }
  return rolled;
}

/** 对方来信：若跟进日已到期则清掉，避免「已回仍因到期日挂着」 */
export function clearDueFollowOnInbound(userId, fromAddr) {
  const scope = scopeFromAddress(fromAddr);
  if (!scope) return null;
  const row = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scope.key);
  if (!row || row.next_follow_at == null || row.next_follow_at > now()) return null;
  db.prepare('UPDATE deals SET next_follow_at = NULL, updated_at = ? WHERE id = ?').run(now(), row.id);
  logEvent(row.id, row.scope_key, userId, 'follow', '对方已回，清除到期跟进');
  return publicDeal(getDealById(row.id), userId);
}

/** 批量挂到 Focus / 列表：按地址解析 scope */
export function attachDeals(viewerId, messages = []) {
  if (!messages.length) return messages;
  const keys = new Set();
  const keyOf = new Map();
  for (const m of messages) {
    const addr = m.from?.address || m.to?.address || '';
    // 待回复：用发件人；待跟进：用 follow.to
    const a = m.follow?.to?.address || m.from?.address || addr;
    const scope = scopeFromAddress(a);
    if (!scope) continue;
    keys.add(scope.key);
    keyOf.set(m.id, scope.key);
  }
  if (!keys.size) return messages;
  const ph = [...keys].map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM deals WHERE scope_key IN (${ph})`).all(...keys);
  const byKey = new Map(rows.map((r) => [r.scope_key, publicDeal(r, viewerId)]));
  return messages.map((m) => {
    const k = keyOf.get(m.id);
    const deal = k ? byKey.get(k) : null;
    return deal ? { ...m, deal } : m;
  });
}

/** 我的客户 / 团队管线轻列表 */
export function listDeals(viewerId, { owner = 'mine', stage, limit = 100 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  const clauses = [];
  const params = [];
  if (owner === 'mine') {
    clauses.push('owner_user_id = ?');
    params.push(viewerId);
  } else if (owner === 'others') {
    clauses.push('owner_user_id != ?');
    params.push(viewerId);
  }
  if (stage && isValidStage(stage)) {
    clauses.push('stage = ?');
    params.push(stage);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM deals ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, lim);
  return rows.map((r) => publicDeal(r, viewerId));
}

/** 从主题/正文推断「发信后可推进到」的阶段（软建议，不自动改） */
export function suggestStageAfterSend(currentStage, subject = '', text = '') {
  const blob = `${subject}\n${text}`.toLowerCase();
  let hint = null;
  if (/\b(pi|proforma|invoice|payment|tt\b|wire|deposit|付款|形式发票|定金|尾款)\b/i.test(blob)) hint = 'payment';
  else if (/\b(po\b|purchase order|bulk order|大货|订单确认|confirm.*(order|po))\b/i.test(blob)) hint = 'bulk';
  else if (/\b(sample|lab dip|strike off|样品|色卡|产前样)\b/i.test(blob)) hint = 'sample';
  else if (/\b(quot(e|ation)|offer|price list|报价|单价|fob|cif)\b/i.test(blob)) hint = 'quote';
  else if (/\b(inquiry|enquiry|rfq|询盘|询价)\b/i.test(blob)) hint = 'inquiry';
  if (!hint) return null;
  const order = STAGES.map((s) => s.id);
  const cur = order.indexOf(currentStage || 'inquiry');
  const next = order.indexOf(hint);
  // 仅建议前进（或同级确认到 quote/sample），不建议回退到更早阶段
  if (next < 0) return null;
  if (cur >= 0 && next < cur) return null;
  if (hint === currentStage) return null;
  const meta = stageMeta(hint);
  return { stage: meta.id, label: meta.label, color: meta.color };
}

function firstClaimAddress(payload = {}, selfEmails = []) {
  const self = new Set((selfEmails || []).map((e) => String(e || '').toLowerCase()));
  const parseList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) {
      return v
        .map((x) => (typeof x === 'string' ? x : x?.address || ''))
        .filter(Boolean);
    }
    return String(v)
      .split(/[,;，；]/)
      .map((s) => {
        const m = s.match(/<?([^\s<>]+@[^\s<>]+)>?/);
        return (m ? m[1] : s).trim();
      })
      .filter((a) => a.includes('@'));
  };
  const candidates = [
    ...parseList(payload.to),
    ...parseList(payload.cc),
    payload.replyTo?.from?.address,
    payload.replyTo?.address,
  ].filter(Boolean);
  for (const raw of candidates) {
    const a = String(raw).trim().toLowerCase();
    if (!a.includes('@') || self.has(a)) continue;
    if (scopeFromAddress(a)) return a;
  }
  return null;
}

/**
 * 发信后认领闭环。mode: auto | off
 * - 未认领 / 自己已认领 → auto 时认领或刷新
 * - 同事已认领 → 不抢，返回 conflict
 */
export function afterOutboundSend(userId, payload = {}, { mode = 'auto', selfEmails = [] } = {}) {
  if (mode === 'off') return { mode, skipped: 'off' };
  const address = firstClaimAddress(payload, selfEmails);
  if (!address) return { mode, skipped: 'no_address' };
  const threadId = payload.replyTo?.threadId || payload.threadId || null;
  const subject = payload.subject || '';
  const text = String(payload.text || payload.bodyText || '').slice(0, 2000);
  const existing = lookup(userId, { address, threadId });
  let deal = existing.deal;
  let claimed = false;
  let conflict = false;
  const wasMine = !!deal?.mine;

  if (deal && !deal.mine) {
    conflict = true;
  } else if (mode === 'auto') {
    try {
      deal = claim(userId, { address, threadId, note: '' });
      claimed = !wasMine;
    } catch (e) {
      if (e.status === 409) {
        conflict = true;
        deal = e.deal || deal;
      } else throw e;
    }
  }

  const stageSuggest = deal?.mine ? suggestStageAfterSend(deal.stage, subject, text) : null;
  return {
    mode,
    address,
    deal,
    claimed: !!claimed && !!deal?.mine,
    conflict,
    stageSuggest,
  };
}
