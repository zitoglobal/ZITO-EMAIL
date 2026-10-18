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

/**
 * 解析认领粒度：企业域默认可按公司（c:@domain）或按个人（a:email）；
 * 公共邮箱只有个人键。lookup 优先命中个人认领，避免「一人锁整司」后无法跟同域其它采购。
 */
export function resolveScopes(address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a || !a.includes('@') || ROBOT.test(a)) return null;
  const person = { key: 'a:' + a, kind: 'address', label: a, address: a };
  const d = domainOf(a);
  if (d && !isFreeDomain(d)) {
    const company = { key: 'c:@' + d, kind: 'company', label: '@' + d, address: a };
    return { person, company, default: company };
  }
  return { person, company: null, default: person };
}

/** 默认认领键：企业域 → 公司；公共邮箱 → 个人（兼容旧调用） */
export function scopeFromAddress(address, scopeKind) {
  const scopes = resolveScopes(address);
  if (!scopes) return null;
  if (scopeKind === 'address' || scopeKind === 'person') return scopes.person;
  if (scopeKind === 'company' && scopes.company) return scopes.company;
  return scopes.default;
}

function userRow(id) {
  return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);
}

/** 改阶段后默认跟进偏移（天）；won/lost/inquiry 不自动开序列 */
export const FOLLOW_SEQ_DAYS = {
  quote: 3,
  sample: 7,
  bulk: 5,
  payment: 3,
};

const SAMPLE_TYPES = new Set(['sms', 'fit', 'pp', 'other']);
const SAMPLE_STATUS = new Set(['planned', 'sent', 'received', 'approved', 'rejected']);
const INCOTERMS = new Set(['', 'FOB', 'CIF', 'CFR', 'EXW', 'DDP', 'DAP', 'FCA']);

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
    /** 当前用户邮箱内可打开的最近线索邮件（列表附加，见 attachLastMessageIds） */
    lastMessageId: row._lastMessageId != null ? row._lastMessageId : null,
    styleNo: row.style_no || '',
    currency: row.currency || 'USD',
    amount: row.amount != null ? Number(row.amount) : null,
    moq: row.moq || '',
    leadDays: row.lead_days != null ? Number(row.lead_days) : null,
    incoterm: row.incoterm || '',
    quoteValidUntil: row.quote_valid_until || null,
    brandId: row.brand_id || null,
    autoFollowSeq: row.auto_follow_seq !== 0,
    owner: owner
      ? { id: owner.id, name: owner.name || owner.email, email: owner.email, role: owner.role }
      : { id: row.owner_user_id, name: '未知同事', email: '', role: 'member' },
    mine: row.owner_user_id === viewerId,
    canRelease: row.owner_user_id === viewerId || userRow(viewerId)?.role === 'admin',
    canTakeover: row.owner_user_id !== viewerId && userRow(viewerId)?.role === 'admin',
  };
}

function assertDealWrite(userId, dealId) {
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  if (row.owner_user_id !== userId && userRow(userId)?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以修改'), { status: 403 });
  }
  return row;
}

function applyFollowSeq(userId, row, stage, { force = false } = {}) {
  if (row.auto_follow_seq === 0) return;
  const days = FOLLOW_SEQ_DAYS[stage];
  if (!days) return;
  const at = now();
  const due = row.next_follow_at;
  // 改阶段/记寄样默认 force；手动设了未来跟进日时，非 force 不覆盖
  if (!force && due != null && due > at) return;
  const nextAt = at + days * 24 * 3600 * 1000;
  db.prepare('UPDATE deals SET next_follow_at = ?, updated_at = ? WHERE id = ?').run(nextAt, at, row.id);
  logEvent(row.id, row.scope_key, userId, 'follow_seq', `${stageMeta(stage).label}后 ${days} 天跟进`);
}

/** 报价要点 / 外贸字段 */
export function updateCommerce(userId, dealId, patch = {}) {
  const row = assertDealWrite(userId, dealId);
  const t = now();
  const styleNo = patch.styleNo != null ? String(patch.styleNo).trim().slice(0, 80) : row.style_no;
  const currency = patch.currency != null ? String(patch.currency).trim().toUpperCase().slice(0, 8) || 'USD' : row.currency;
  let amount = row.amount;
  if ('amount' in patch) {
    if (patch.amount == null || patch.amount === '') amount = null;
    else {
      amount = Number(patch.amount);
      if (!Number.isFinite(amount)) throw Object.assign(new Error('金额无效'), { status: 400 });
    }
  }
  const moq = patch.moq != null ? String(patch.moq).trim().slice(0, 80) : row.moq;
  let leadDays = row.lead_days;
  if ('leadDays' in patch) {
    if (patch.leadDays == null || patch.leadDays === '') leadDays = null;
    else {
      leadDays = Number(patch.leadDays);
      if (!Number.isFinite(leadDays) || leadDays < 0) throw Object.assign(new Error('交期无效'), { status: 400 });
    }
  }
  let incoterm = row.incoterm || '';
  if (patch.incoterm != null) {
    const ic = String(patch.incoterm).trim().toUpperCase();
    if (!INCOTERMS.has(ic)) throw Object.assign(new Error('贸易术语无效'), { status: 400 });
    incoterm = ic;
  }
  let quoteValidUntil = row.quote_valid_until;
  if ('quoteValidUntil' in patch) {
    if (patch.quoteValidUntil == null || patch.quoteValidUntil === '') quoteValidUntil = null;
    else {
      quoteValidUntil = Number(patch.quoteValidUntil);
      if (!Number.isFinite(quoteValidUntil)) throw Object.assign(new Error('有效期无效'), { status: 400 });
    }
  }
  let brandId = row.brand_id;
  if ('brandId' in patch) {
    brandId = patch.brandId == null || patch.brandId === '' ? null : Number(patch.brandId);
  }
  let autoFollowSeq = row.auto_follow_seq;
  if ('autoFollowSeq' in patch) autoFollowSeq = patch.autoFollowSeq ? 1 : 0;

  db.prepare(
    `UPDATE deals SET style_no = ?, currency = ?, amount = ?, moq = ?, lead_days = ?, incoterm = ?,
      quote_valid_until = ?, brand_id = ?, auto_follow_seq = ?, updated_at = ? WHERE id = ?`
  ).run(styleNo || '', currency || 'USD', amount, moq || '', leadDays, incoterm || '', quoteValidUntil, brandId, autoFollowSeq, t, dealId);

  const bits = [];
  if (styleNo) bits.push(`款 ${styleNo}`);
  if (amount != null) bits.push(`${currency || 'USD'} ${amount}`);
  if (moq) bits.push(`MOQ ${moq}`);
  if (bits.length) logEvent(dealId, row.scope_key, userId, 'commerce', bits.join(' · '));
  return publicDeal(getDealById(dealId), userId);
}

export function listStyles(dealId) {
  return db
    .prepare('SELECT * FROM deal_styles WHERE deal_id = ? ORDER BY updated_at DESC, id DESC')
    .all(dealId)
    .map((r) => ({
      id: r.id,
      dealId: r.deal_id,
      styleNo: r.style_no,
      colorway: r.colorway,
      sizeRange: r.size_range,
      note: r.note,
      updatedAt: r.updated_at,
    }));
}

export function upsertStyle(userId, dealId, body = {}) {
  assertDealWrite(userId, dealId);
  const t = now();
  const styleNo = String(body.styleNo || '').trim().slice(0, 80);
  if (!styleNo) throw Object.assign(new Error('请填写款号'), { status: 400 });
  const colorway = String(body.colorway || '').trim().slice(0, 120);
  const sizeRange = String(body.sizeRange || '').trim().slice(0, 120);
  const note = String(body.note || '').trim().slice(0, 200);
  if (body.id) {
    const ex = db.prepare('SELECT id FROM deal_styles WHERE id = ? AND deal_id = ?').get(body.id, dealId);
    if (!ex) throw Object.assign(new Error('款号不存在'), { status: 404 });
    db.prepare(
      `UPDATE deal_styles SET style_no = ?, colorway = ?, size_range = ?, note = ?, updated_at = ? WHERE id = ?`
    ).run(styleNo, colorway, sizeRange, note, t, body.id);
    return listStyles(dealId).find((s) => s.id === body.id);
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO deal_styles (deal_id, style_no, colorway, size_range, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(dealId, styleNo, colorway, sizeRange, note, t).lastInsertRowid
  );
  db.prepare('UPDATE deals SET style_no = CASE WHEN style_no = \'\' THEN ? ELSE style_no END, updated_at = ? WHERE id = ?').run(
    styleNo,
    t,
    dealId
  );
  return listStyles(dealId).find((s) => s.id === id);
}

export function deleteStyle(userId, dealId, styleId) {
  assertDealWrite(userId, dealId);
  db.prepare('DELETE FROM deal_styles WHERE id = ? AND deal_id = ?').run(styleId, dealId);
  return { ok: true };
}

export function listSamples(dealId) {
  return db
    .prepare('SELECT * FROM deal_samples WHERE deal_id = ? ORDER BY updated_at DESC, id DESC')
    .all(dealId)
    .map((r) => ({
      id: r.id,
      dealId: r.deal_id,
      sampleType: r.sample_type,
      trackingNo: r.tracking_no,
      carrier: r.carrier,
      sentAt: r.sent_at,
      status: r.status,
      note: r.note,
      updatedAt: r.updated_at,
    }));
}

export function upsertSample(userId, dealId, body = {}) {
  assertDealWrite(userId, dealId);
  const t = now();
  const sampleType = SAMPLE_TYPES.has(body.sampleType) ? body.sampleType : 'sms';
  const status = SAMPLE_STATUS.has(body.status) ? body.status : 'planned';
  const trackingNo = String(body.trackingNo || '').trim().slice(0, 80);
  const carrier = String(body.carrier || '').trim().slice(0, 40);
  const note = String(body.note || '').trim().slice(0, 200);
  let sentAt = body.sentAt != null && body.sentAt !== '' ? Number(body.sentAt) : null;
  if (sentAt != null && !Number.isFinite(sentAt)) sentAt = null;
  if (status === 'sent' && !sentAt) sentAt = t;

  let sampleId = body.id ? Number(body.id) : null;
  if (body.id) {
    const ex = db.prepare('SELECT id FROM deal_samples WHERE id = ? AND deal_id = ?').get(body.id, dealId);
    if (!ex) throw Object.assign(new Error('样品记录不存在'), { status: 404 });
    db.prepare(
      `UPDATE deal_samples SET sample_type = ?, tracking_no = ?, carrier = ?, sent_at = ?, status = ?, note = ?, updated_at = ?
       WHERE id = ?`
    ).run(sampleType, trackingNo, carrier, sentAt, status, note, t, body.id);
  } else {
    sampleId = Number(
      db
        .prepare(
          `INSERT INTO deal_samples (deal_id, sample_type, tracking_no, carrier, sent_at, status, note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(dealId, sampleType, trackingNo, carrier, sentAt, status, note, t).lastInsertRowid
    );
  }
  const row = assertDealWrite(userId, dealId);
  logEvent(dealId, row.scope_key, userId, 'sample', `${sampleType.toUpperCase()} · ${status}${trackingNo ? ` · ${trackingNo}` : ''}`);
  applySampleSideEffects(userId, dealId, { sampleType, status });
  return listSamples(dealId).find((s) => s.id === sampleId);
}

/** 记样品副作用：询盘/报价→样品阶段；寄出后按序列写跟进日 */
function applySampleSideEffects(userId, dealId, { status } = {}) {
  const row = getDealById(dealId);
  if (!row) return;
  if (status === 'sent' || status === 'received') {
    if (row.stage === 'inquiry' || row.stage === 'quote') {
      setStage(userId, dealId, 'sample');
      return; // setStage 已 applyFollowSeq force
    }
    applyFollowSeq(userId, row, 'sample', { force: status === 'sent' });
  } else if (status === 'approved') {
    applyFollowSeq(userId, row, 'bulk', { force: true });
  }
}

export function deleteSample(userId, dealId, sampleId) {
  assertDealWrite(userId, dealId);
  db.prepare('DELETE FROM deal_samples WHERE id = ? AND deal_id = ?').run(sampleId, dealId);
  return { ok: true };
}

/** 生成可粘贴进邮件的报价要点纯文本（含多款号） */
export function quoteSnippet(deal, { styles } = {}) {
  if (!deal) return '';
  const lines = ['【报价要点】'];
  const styleRows = Array.isArray(styles)
    ? styles
    : deal.id
      ? listStyles(deal.id)
      : [];
  if (styleRows.length) {
    for (const s of styleRows.slice(0, 8)) {
      const bits = [s.styleNo];
      if (s.colorway) bits.push(s.colorway);
      if (s.sizeRange) bits.push(s.sizeRange);
      lines.push(`Style: ${bits.join(' / ')}`);
    }
  } else if (deal.styleNo) {
    lines.push(`Style: ${deal.styleNo}`);
  }
  if (deal.amount != null) lines.push(`Amount: ${deal.currency || 'USD'} ${deal.amount}`);
  if (deal.moq) lines.push(`MOQ: ${deal.moq}`);
  if (deal.leadDays != null) lines.push(`Lead time: ${deal.leadDays} days`);
  if (deal.incoterm) lines.push(`Incoterm: ${deal.incoterm}`);
  if (deal.quoteValidUntil) {
    lines.push(`Valid until: ${new Date(deal.quoteValidUntil).toLocaleDateString('en-CA')}`);
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}

/** 拆分/合并时拷贝外贸标量字段 */
function copyCommerceToDeal(fromRow, toId, t) {
  db.prepare(
    `UPDATE deals SET style_no = ?, currency = ?, amount = ?, moq = ?, lead_days = ?,
      incoterm = ?, quote_valid_until = ?, brand_id = ?, auto_follow_seq = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    fromRow.style_no || '',
    fromRow.currency || 'USD',
    fromRow.amount,
    fromRow.moq || '',
    fromRow.lead_days,
    fromRow.incoterm || '',
    fromRow.quote_valid_until,
    fromRow.brand_id,
    fromRow.auto_follow_seq != null ? fromRow.auto_follow_seq : 1,
    t,
    toId
  );
}

/** 将款号/样品挂到目标 deal（避免 DELETE CASCADE 清空） */
function reassignDealChildren(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  db.prepare('UPDATE deal_styles SET deal_id = ? WHERE deal_id = ?').run(toId, fromId);
  db.prepare('UPDATE deal_samples SET deal_id = ? WHERE deal_id = ?').run(toId, fromId);
}

function logEvent(dealId, scopeKey, actorUserId, action, detail = '') {
  db.prepare(
    `INSERT INTO deal_events (deal_id, scope_key, actor_user_id, action, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(dealId || null, scopeKey, actorUserId, action, String(detail || '').slice(0, 200), now());
}

function canViewDealEvents(viewerId, scopeKeys, dealRow) {
  const viewer = userRow(viewerId);
  if (!viewer) return false;
  if (viewer.role === 'admin') return true;
  if (dealRow?.owner_user_id === viewerId) return true;
  if (scopeKeys.length) {
    const ph = scopeKeys.map(() => '?').join(',');
    const owns = db
      .prepare(`SELECT 1 AS ok FROM deals WHERE owner_user_id = ? AND scope_key IN (${ph}) LIMIT 1`)
      .get(viewerId, ...scopeKeys);
    if (owns) return true;
  }
  for (const sk of scopeKeys) {
    if (sk.startsWith('p:')) {
      const addr = sk.slice(2).toLowerCase();
      const hit = db
        .prepare(
          `SELECT 1 AS ok FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
           WHERE b.user_id = ? AND lower(m.from_addr) = ? LIMIT 1`
        )
        .get(viewerId, addr);
      if (hit) return true;
    } else if (sk.startsWith('c:')) {
      const dom = sk.slice(2).toLowerCase();
      const hit = db
        .prepare(
          `SELECT 1 AS ok FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
           WHERE b.user_id = ? AND lower(m.from_addr) LIKE ? LIMIT 1`
        )
        .get(viewerId, `%@${dom}`);
      if (hit) return true;
    }
  }
  return false;
}

/** 最近认领/阶段变更（按 scope 或 deal；需有权查看） */
export function listEvents(viewerId, { dealId, address, limit = 12 } = {}) {
  let dealRow = null;
  let scopeKey = null;
  if (dealId) {
    dealRow = getDealById(dealId);
    if (dealRow) scopeKey = dealRow.scope_key;
  }
  let scopeKeys = scopeKey ? [scopeKey] : [];
  if (!scopeKeys.length && address) {
    const scopes = resolveScopes(address);
    if (scopes) {
      scopeKeys = [scopes.person.key];
      if (scopes.company) scopeKeys.push(scopes.company.key);
    }
  }
  if (!scopeKeys.length) return [];
  if (!canViewDealEvents(viewerId, scopeKeys, dealRow)) return [];
  const lim = Math.min(40, Math.max(1, Number(limit) || 12));
  const ph = scopeKeys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, deal_id, scope_key, actor_user_id, action, detail, created_at
       FROM deal_events WHERE scope_key IN (${ph}) ORDER BY created_at DESC LIMIT ?`
    )
    .all(...scopeKeys, lim);
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

export function getPublicDeal(userId, dealId) {
  return publicDeal(getDealById(dealId), userId);
}

export function lookup(viewerId, { address, threadId } = {}) {
  const scopes = resolveScopes(address);
  if (!scopes) return { deal: null, scope: null, scopes: null, canSplit: false, stages: STAGES };
  const personRow = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scopes.person.key);
  const companyRow = scopes.company
    ? db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scopes.company.key)
    : null;
  // 个人认领优先于公司域，便于同域多采购并行跟进
  const row = personRow || companyRow;
  const deal = publicDeal(row, viewerId);
  const matched = personRow ? scopes.person : companyRow ? scopes.company : scopes.default;
  void threadId;
  return {
    deal,
    scope: matched ? { key: matched.key, kind: matched.kind, label: matched.label } : null,
    scopes: {
      person: { key: scopes.person.key, kind: scopes.person.kind, label: scopes.person.label },
      company: scopes.company
        ? { key: scopes.company.key, kind: scopes.company.kind, label: scopes.company.label }
        : null,
    },
    companyDeal: companyRow && personRow ? publicDeal(companyRow, viewerId) : null,
    canSplit: !!(deal?.mine && deal.scopeKind === 'company' && scopes.person),
    canClaimPerson: !!(scopes.company && !personRow),
    stages: STAGES,
  };
}

/**
 * 认领客户。他人已认领时默认 409；admin 或 force=true 可接管。
 * scopeKind: 'company' | 'address'（企业域可拆到个人，避免一人锁整司）
 */
export function claim(userId, { address, threadId, note, force = false, scopeKind } = {}) {
  const scope = scopeFromAddress(address, scopeKind);
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

/**
 * 管理员指派给指定成员（写入认领归属；被指派人收到 SSE 后可进今日待办跟进）。
 */
export function assign(adminId, { address, toUserId, threadId, note, scopeKind } = {}) {
  const admin = userRow(adminId);
  if (admin?.role !== 'admin') throw Object.assign(new Error('需要管理员权限'), { status: 403 });
  const targetId = Number(toUserId);
  const target = userRow(targetId);
  if (!target) throw Object.assign(new Error('指派对象不存在'), { status: 404 });
  const scope = scopeFromAddress(address, scopeKind);
  if (!scope) throw Object.assign(new Error('无法指派：发件人地址无效'), { status: 400 });
  const t = now();
  const existing = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scope.key);
  const noteStr = String(note || '').trim().slice(0, 200);

  if (existing) {
    const prev = userRow(existing.owner_user_id);
    db.prepare(
      `UPDATE deals SET owner_user_id = ?, claimed_at = ?, note = CASE WHEN ? != '' THEN ? ELSE note END,
        last_thread_id = COALESCE(?, last_thread_id), last_address = ?, updated_at = ?
       WHERE id = ?`
    ).run(targetId, t, noteStr, noteStr, threadId || null, scope.address, t, existing.id);
    logEvent(
      existing.id,
      scope.key,
      adminId,
      'assign',
      `指派给 ${target.name || target.email}` + (prev && prev.id !== targetId ? `（原 ${prev.name || prev.email}）` : '')
    );
    return publicDeal(getDealById(existing.id), adminId);
  }

  const info = db
    .prepare(
      `INSERT INTO deals
        (scope_key, scope_kind, owner_user_id, claimed_at, stage, stage_updated_at, note, last_thread_id, last_address, updated_at)
       VALUES (?, ?, ?, ?, 'inquiry', ?, ?, ?, ?, ?)`
    )
    .run(scope.key, scope.kind, targetId, t, t, noteStr, threadId || null, scope.address, t);
  const newId = Number(info.lastInsertRowid);
  logEvent(newId, scope.key, adminId, 'assign', `指派给 ${target.name || target.email}`);
  return publicDeal(getDealById(newId), adminId);
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

/**
 * 将公司域认领拆到当前联系人个人键，并释放公司锁，便于同事跟同域其它采购。
 * 事务内迁移报价标量 + 款号/样品，避免 DELETE CASCADE 清空成交记忆。
 */
export function splitToPerson(userId, dealId) {
  const row = getDealById(dealId);
  if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
  if (row.scope_kind !== 'company') {
    throw Object.assign(new Error('仅公司域认领可拆到个人'), { status: 400 });
  }
  const user = userRow(userId);
  if (row.owner_user_id !== userId && user?.role !== 'admin') {
    throw Object.assign(new Error('只有认领人或管理员可以拆分'), { status: 403 });
  }
  const address = String(row.last_address || '').trim().toLowerCase();
  if (!address || !address.includes('@')) {
    throw Object.assign(new Error('缺少联系人地址，无法拆到个人'), { status: 400 });
  }
  const person = scopeFromAddress(address, 'address');
  if (!person || person.kind !== 'address') {
    throw Object.assign(new Error('该地址无法拆到个人'), { status: 400 });
  }
  const t = now();
  const existingPerson = db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(person.key);
  if (existingPerson && existingPerson.owner_user_id !== row.owner_user_id) {
    throw Object.assign(
      new Error(`${publicDeal(existingPerson, userId).owner.name} 已认领此联系人`),
      { status: 409, deal: publicDeal(existingPerson, userId) }
    );
  }

  const run = db.transaction(() => {
    let personId = existingPerson?.id;
    if (existingPerson) {
      db.prepare(
        `UPDATE deals SET owner_user_id = ?, stage = ?, stage_updated_at = ?, note = ?,
          next_follow_at = ?, last_thread_id = COALESCE(?, last_thread_id), last_address = ?,
          claimed_at = ?, updated_at = ? WHERE id = ?`
      ).run(
        row.owner_user_id,
        row.stage,
        row.stage_updated_at || t,
        row.note || '',
        row.next_follow_at,
        row.last_thread_id,
        address,
        row.claimed_at || t,
        t,
        existingPerson.id
      );
      copyCommerceToDeal(row, existingPerson.id, t);
    } else {
      const info = db
        .prepare(
          `INSERT INTO deals
            (scope_key, scope_kind, owner_user_id, claimed_at, stage, stage_updated_at, note,
             next_follow_at, last_thread_id, last_address, updated_at,
             style_no, currency, amount, moq, lead_days, incoterm, quote_valid_until, brand_id, auto_follow_seq)
           VALUES (?, 'address', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          person.key,
          row.owner_user_id,
          row.claimed_at || t,
          row.stage,
          row.stage_updated_at || t,
          row.note || '',
          row.next_follow_at,
          row.last_thread_id,
          address,
          t,
          row.style_no || '',
          row.currency || 'USD',
          row.amount,
          row.moq || '',
          row.lead_days,
          row.incoterm || '',
          row.quote_valid_until,
          row.brand_id,
          row.auto_follow_seq != null ? row.auto_follow_seq : 1
        );
      personId = Number(info.lastInsertRowid);
    }
    reassignDealChildren(row.id, personId);
    logEvent(personId, person.key, userId, 'split', `从 ${row.scope_key.slice(2)} 拆到个人`);
    logEvent(row.id, row.scope_key, userId, 'release', '拆分后释放公司域认领');
    db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);
    return personId;
  });

  const personId = run();
  return publicDeal(getDealById(personId), userId);
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
  if (row.stage !== stage) {
    logEvent(dealId, row.scope_key, userId, 'stage', `${from} → ${to}`);
    applyFollowSeq(userId, { ...row, stage }, stage, { force: true });
  }
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

const FOLLOW_REMIND_COOLDOWN = 20 * 3600 * 1000; // 约一天一次

/** 到期跟进 Push：每 deal 冷却约 20h，避免刷屏 */
export function dueFollowToRemind(userId, at = Date.now()) {
  const due = dueFollowDeals(userId, at);
  if (!due.length) return null;
  const items = [];
  for (const d of due.slice(0, 8)) {
    const last = db
      .prepare(
        `SELECT created_at FROM deal_events
         WHERE deal_id = ? AND action = 'follow_remind' ORDER BY created_at DESC LIMIT 1`
      )
      .get(d.id);
    if (last && at - last.created_at < FOLLOW_REMIND_COOLDOWN) continue;
    logEvent(d.id, d.scopeKey, userId, 'follow_remind', '跟进日到期提醒');
    items.push({
      dealId: d.id,
      scopeLabel: d.scopeLabel,
      stageLabel: d.stageLabel,
      address: d.lastAddress,
      messageId: d.lastMessageId,
      nextFollowAt: d.nextFollowAt,
    });
  }
  if (!items.length) return null;
  return { count: items.length, items };
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
    const scopes = resolveScopes(addr);
    if (!scopes) continue;
    const keys = [scopes.person.key];
    if (scopes.company) keys.push(scopes.company.key);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    const row =
      db.prepare('SELECT * FROM deals WHERE scope_key = ? AND owner_user_id = ?').get(scopes.person.key, userId) ||
      (scopes.company
        ? db.prepare('SELECT * FROM deals WHERE scope_key = ? AND owner_user_id = ?').get(scopes.company.key, userId)
        : null);
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
  const scopes = resolveScopes(fromAddr);
  if (!scopes) return null;
  const row =
    db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scopes.person.key) ||
    (scopes.company ? db.prepare('SELECT * FROM deals WHERE scope_key = ?').get(scopes.company.key) : null);
  if (!row || row.next_follow_at == null || row.next_follow_at > now()) return null;
  db.prepare('UPDATE deals SET next_follow_at = NULL, updated_at = ? WHERE id = ?').run(now(), row.id);
  logEvent(row.id, row.scope_key, userId, 'follow', '对方已回，清除到期跟进');
  return publicDeal(getDealById(row.id), userId);
}

/** 批量挂到 Focus / 列表：个人认领优先于公司域 */
export function attachDeals(viewerId, messages = []) {
  if (!messages.length) return messages;
  const keys = new Set();
  const keyPair = new Map();
  for (const m of messages) {
    const addr = m.from?.address || m.to?.address || '';
    const a = m.follow?.to?.address || m.from?.address || addr;
    const scopes = resolveScopes(a);
    if (!scopes) continue;
    keys.add(scopes.person.key);
    if (scopes.company) keys.add(scopes.company.key);
    keyPair.set(m.id, scopes);
  }
  if (!keys.size) return messages;
  const ph = [...keys].map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM deals WHERE scope_key IN (${ph})`).all(...keys);
  const byKey = new Map(rows.map((r) => [r.scope_key, publicDeal(r, viewerId)]));
  return messages.map((m) => {
    const scopes = keyPair.get(m.id);
    if (!scopes) return m;
    const deal = byKey.get(scopes.person.key) || (scopes.company ? byKey.get(scopes.company.key) : null);
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
  const at = now();
  // 跟进到期置顶 → 有跟进日 → 最近更新
  const rows = db
    .prepare(
      `SELECT * FROM deals ${where}
       ORDER BY
         CASE
           WHEN next_follow_at IS NOT NULL AND next_follow_at <= ? THEN 0
           WHEN next_follow_at IS NOT NULL THEN 1
           ELSE 2
         END,
         next_follow_at ASC,
         updated_at DESC
       LIMIT ?`
    )
    .all(...params, at, lim);
  attachLastMessageIds(viewerId, rows);
  return rows.map((r) => publicDeal(r, viewerId));
}

/** 为管线列表解析「打开线索」用的本账号最近邮件 id */
function attachLastMessageIds(viewerId, rows) {
  if (!rows?.length) return;
  const byThread = db.prepare(
    `SELECT m.id FROM messages m
     JOIN mailboxes b ON b.id = m.mailbox_id
     WHERE b.user_id = ? AND m.thread_id = ?
     ORDER BY m.date DESC LIMIT 1`
  );
  const byAddr = db.prepare(
    `SELECT m.id FROM messages m
     JOIN mailboxes b ON b.id = m.mailbox_id
     WHERE b.user_id = ? AND LOWER(m.from_addr) = ?
     ORDER BY m.date DESC LIMIT 1`
  );
  const byTo = db.prepare(
    `SELECT m.id FROM messages m
     JOIN mailboxes b ON b.id = m.mailbox_id
     WHERE b.user_id = ? AND LOWER(m.to_json) LIKE ?
     ORDER BY m.date DESC LIMIT 1`
  );
  for (const r of rows) {
    let mid = null;
    if (r.last_thread_id) {
      mid = byThread.get(viewerId, r.last_thread_id)?.id || null;
    }
    if (!mid && r.last_address) {
      const addr = String(r.last_address).trim().toLowerCase();
      mid = byAddr.get(viewerId, addr)?.id || null;
      if (!mid) mid = byTo.get(viewerId, `%"${addr}"%`)?.id || null;
    }
    r._lastMessageId = mid;
  }
}

/** 从主题/正文推断「发信后可推进到」的阶段（软建议，不自动改；服装链路优先） */
export function suggestStageAfterSend(currentStage, subject = '', text = '') {
  const blob = `${subject}\n${text}`.toLowerCase();
  let hint = null;
  if (/\b(pi|proforma|invoice|payment|tt\b|wire|deposit|付款|形式发票|定金|尾款|水单)\b/i.test(blob)) hint = 'payment';
  else if (/\b(po\b|purchase order|bulk order|大货|订单确认|confirm.*(order|po)|size run|packing list|carton mark)\b/i.test(blob)) hint = 'bulk';
  else if (/\b(sample|lab dip|strike.?off|fit sample|pp sample|size set|sms\b|样品|色卡|产前样|推销样|试穿样)\b/i.test(blob)) hint = 'sample';
  else if (/\b(quot(e|ation)|offer|price list|报价|单价|fob|cif|moq)\b/i.test(blob)) hint = 'quote';
  else if (/\b(inquiry|enquiry|rfq|tech\s*pack|询盘|询价|工艺单)\b/i.test(blob)) hint = 'inquiry';
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
