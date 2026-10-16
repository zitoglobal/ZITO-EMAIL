import { db, now, tx } from './db.js';
import * as labels from './labels.js';
import * as priority from './priority.js';

const MAX_RULES = 100;
const MAX_NAME = 80;
const MAX_CONDS = 10;
const MAX_ACTIONS = 8;

const CONDITION_FIELDS = new Set(['from', 'subject', 'has_att', 'to_me', 'category', 'mailbox_id', 'keyword']);
const CONDITION_OPS = new Set(['is', 'contains', 'not_contains', 'domain']);
const ACTION_TYPES = new Set([
  'apply_label',
  'mark_read',
  'star',
  'move_folder',
  'skip_inbox',
  'mark_vip',
  'mute_sender',
  'archive',
]);

const CATEGORIES = new Set(['people', 'notification', 'newsletter']);

function sanitizeName(name, conditions) {
  const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (n) return n;
  return autoName(conditions) || '未命名规则';
}

function autoName(conditions = []) {
  const parts = [];
  for (const c of conditions.slice(0, 3)) {
    if (c.field === 'from' && c.op === 'domain') parts.push(`来自 ${c.value}`);
    else if (c.field === 'from' && c.op === 'is') parts.push(`来自 ${c.value}`);
    else if (c.field === 'from' && c.op === 'contains') parts.push(`发件人含 ${c.value}`);
    else if (c.field === 'subject' && c.op === 'contains') parts.push(`主题含「${c.value}」`);
    else if (c.field === 'subject' && c.op === 'not_contains') parts.push(`主题不含「${c.value}」`);
    else if (c.field === 'has_att' && (c.value === true || c.value === 'true' || c.value === 1 || c.value === '1'))
      parts.push('有附件');
    else if (c.field === 'to_me') parts.push('收件人是我');
    else if (c.field === 'category') parts.push(`分类 ${categoryLabel(c.value)}`);
    else if (c.field === 'keyword') parts.push(`含「${c.value}」`);
  }
  return parts.join(' 且 ') || '';
}

function categoryLabel(v) {
  return { people: '人际', notification: '通知', newsletter: '订阅' }[v] || v;
}

function parseJson(s, fallback) {
  try {
    const v = JSON.parse(s || '');
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeConditions(raw) {
  if (!Array.isArray(raw) || !raw.length) throw Object.assign(new Error('请至少添加一个条件'), { status: 400 });
  if (raw.length > MAX_CONDS) throw Object.assign(new Error(`最多 ${MAX_CONDS} 个条件`), { status: 400 });
  const out = [];
  for (const c of raw) {
    const field = String(c?.field || '').trim();
    const op = String(c?.op || '').trim();
    if (!CONDITION_FIELDS.has(field)) throw Object.assign(new Error(`不支持的条件字段：${field}`), { status: 400 });
    if (!CONDITION_OPS.has(op)) throw Object.assign(new Error(`不支持的条件运算符：${op}`), { status: 400 });

    if (field === 'has_att' || field === 'to_me') {
      if (op !== 'is') throw Object.assign(new Error('该条件请使用「是」'), { status: 400 });
      const truthy = c.value === true || c.value === 'true' || c.value === 1 || c.value === '1' || c.value === undefined || c.value === '';
      out.push({ field, op: 'is', value: truthy ? true : false });
      continue;
    }
    if (field === 'category') {
      if (op !== 'is') throw Object.assign(new Error('分类请使用「是」'), { status: 400 });
      const v = String(c.value || '').trim().toLowerCase();
      if (!CATEGORIES.has(v)) throw Object.assign(new Error('分类须为 人际 / 通知 / 订阅'), { status: 400 });
      out.push({ field, op: 'is', value: v });
      continue;
    }
    if (field === 'mailbox_id') {
      if (op !== 'is') throw Object.assign(new Error('邮箱账号请使用「是」'), { status: 400 });
      const v = String(c.value || '').trim();
      if (!v) throw Object.assign(new Error('请选择邮箱账号'), { status: 400 });
      out.push({ field, op: 'is', value: v });
      continue;
    }
    if (field === 'from' && op === 'domain') {
      const k = priority.normalizeKey(String(c.value || '').startsWith('@') ? c.value : '@' + String(c.value || '').replace(/^@/, ''));
      if (!k || !k.startsWith('@')) throw Object.assign(new Error('请输入有效域名，例如 @acme.com'), { status: 400 });
      out.push({ field, op: 'domain', value: k });
      continue;
    }
    if (field === 'from' && op === 'is') {
      const k = priority.normalizeKey(c.value);
      if (!k || k.startsWith('@')) throw Object.assign(new Error('请输入完整邮箱地址'), { status: 400 });
      out.push({ field, op: 'is', value: k });
      continue;
    }
    const val = String(c.value ?? '').trim().slice(0, 200);
    if (!val) throw Object.assign(new Error('请完善条件'), { status: 400 });
    if (field === 'from' && !['contains', 'is', 'domain'].includes(op)) {
      throw Object.assign(new Error('发件人运算符无效'), { status: 400 });
    }
    if (field === 'subject' && !['contains', 'not_contains'].includes(op)) {
      throw Object.assign(new Error('主题运算符无效'), { status: 400 });
    }
    if (field === 'keyword' && op !== 'contains') {
      throw Object.assign(new Error('关键词请使用「包含」'), { status: 400 });
    }
    out.push({ field, op, value: val });
  }
  return out;
}

function sanitizeActions(raw) {
  if (!Array.isArray(raw) || !raw.length) throw Object.assign(new Error('请至少添加一个动作'), { status: 400 });
  if (raw.length > MAX_ACTIONS) throw Object.assign(new Error(`最多 ${MAX_ACTIONS} 个动作`), { status: 400 });
  const out = [];
  for (const a of raw) {
    const type = String(a?.type || '').trim();
    if (!ACTION_TYPES.has(type)) throw Object.assign(new Error(`不支持的动作：${type}`), { status: 400 });
    const params = a.params && typeof a.params === 'object' ? { ...a.params } : {};
    if (type === 'apply_label') {
      const labelId = Number(params.labelId ?? a.labelId);
      if (!Number.isInteger(labelId)) throw Object.assign(new Error('请选择要贴的标签'), { status: 400 });
      out.push({ type, params: { labelId } });
      continue;
    }
    if (type === 'move_folder') {
      const folder = String(params.folder || a.folder || '').trim();
      if (!folder) throw Object.assign(new Error('请选择目标文件夹'), { status: 400 });
      out.push({ type, params: { folder: folder.slice(0, 500) } });
      continue;
    }
    if (type === 'mark_vip' || type === 'mute_sender') {
      const key = params.key != null ? String(params.key).trim().slice(0, 120) : '';
      const name = params.name != null ? String(params.name).trim().slice(0, 60) : '';
      out.push({ type, params: { ...(key ? { key } : {}), ...(name ? { name } : {}) } });
      continue;
    }
    out.push({ type, params: {} });
  }
  return out;
}

function rowPublic(r) {
  if (!r) return null;
  const conditions = parseJson(r.conditions_json, []);
  const actions = parseJson(r.actions_json, []);
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    position: r.position,
    stopProcessing: !!r.stop_processing,
    conditions,
    actions,
    lastHitAt: r.last_hit_at || null,
    lastHitSummary: r.last_hit_summary || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary: summarizeRule(conditions, actions),
  };
}

function actionLabel(a) {
  switch (a.type) {
    case 'apply_label':
      return '贴标签';
    case 'mark_read':
      return '标已读';
    case 'star':
      return '星标';
    case 'move_folder':
      return `移到 ${a.params?.folder || '文件夹'}`;
    case 'skip_inbox':
      return '跳过收件箱';
    case 'mark_vip':
      return '标为 VIP';
    case 'mute_sender':
      return '静音发件人';
    case 'archive':
      return '归档';
    default:
      return a.type;
  }
}

function summarizeRule(conditions, actions) {
  const cond = autoName(conditions) || '条件';
  const act = (actions || []).map(actionLabel).join(' · ');
  return act ? `${cond} → ${act}` : cond;
}

export function listRules(userId) {
  return db
    .prepare(
      `SELECT id, name, enabled, position, stop_processing, conditions_json, actions_json,
              last_hit_at, last_hit_summary, created_at, updated_at
       FROM mail_rules WHERE user_id = ? ORDER BY position ASC, id ASC`
    )
    .all(userId)
    .map(rowPublic);
}

export function getRule(userId, id) {
  const r = db
    .prepare(
      `SELECT id, name, enabled, position, stop_processing, conditions_json, actions_json,
              last_hit_at, last_hit_summary, created_at, updated_at
       FROM mail_rules WHERE user_id = ? AND id = ?`
    )
    .get(userId, id);
  return rowPublic(r);
}

export function createRule(userId, body = {}) {
  const conditions = sanitizeConditions(body.conditions);
  const actions = sanitizeActions(body.actions);
  const name = sanitizeName(body.name, conditions);
  const total = db.prepare('SELECT COUNT(*) AS n FROM mail_rules WHERE user_id = ?').get(userId).n;
  if (total >= MAX_RULES) throw Object.assign(new Error(`最多创建 ${MAX_RULES} 条规则`), { status: 400 });
  const pos =
    body.position != null
      ? Number(body.position)
      : (db.prepare('SELECT IFNULL(MAX(position), -1) + 1 AS p FROM mail_rules WHERE user_id = ?').get(userId).p || 0);
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO mail_rules
        (user_id, name, enabled, position, stop_processing, conditions_json, actions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      name,
      body.enabled === false || body.enabled === 0 ? 0 : 1,
      pos,
      body.stopProcessing || body.stop_processing ? 1 : 0,
      JSON.stringify(conditions),
      JSON.stringify(actions),
      t,
      t
    );
  return getRule(userId, Number(info.lastInsertRowid));
}

export function updateRule(userId, id, patch = {}) {
  const row = getRule(userId, id);
  if (!row) throw Object.assign(new Error('规则不存在'), { status: 404 });
  let name = row.name;
  let enabled = row.enabled ? 1 : 0;
  let position = row.position;
  let stop = row.stopProcessing ? 1 : 0;
  let conditions = row.conditions;
  let actions = row.actions;
  if (patch.conditions != null) conditions = sanitizeConditions(patch.conditions);
  if (patch.actions != null) actions = sanitizeActions(patch.actions);
  if (patch.name != null) name = sanitizeName(patch.name, conditions);
  else if (patch.conditions != null && !String(row.name || '').trim()) name = sanitizeName('', conditions);
  if (patch.enabled != null) enabled = patch.enabled === false || patch.enabled === 0 ? 0 : 1;
  if (patch.position != null) position = Number(patch.position) || 0;
  if (patch.stopProcessing != null || patch.stop_processing != null) {
    stop = patch.stopProcessing || patch.stop_processing ? 1 : 0;
  }
  db.prepare(
    `UPDATE mail_rules SET name = ?, enabled = ?, position = ?, stop_processing = ?,
      conditions_json = ?, actions_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(name, enabled, position, stop, JSON.stringify(conditions), JSON.stringify(actions), now(), id, userId);
  return getRule(userId, id);
}

export function deleteRule(userId, id) {
  const row = getRule(userId, id);
  if (!row) throw Object.assign(new Error('规则不存在'), { status: 404 });
  db.prepare('DELETE FROM mail_rules WHERE id = ? AND user_id = ?').run(id, userId);
  return { ok: true };
}

export function reorderRules(userId, ids = []) {
  const list = listRules(userId);
  const have = new Set(list.map((r) => r.id));
  const ordered = ids.map(Number).filter((id) => have.has(id));
  for (const r of list) if (!ordered.includes(r.id)) ordered.push(r.id);
  const st = db.prepare('UPDATE mail_rules SET position = ?, updated_at = ? WHERE id = ? AND user_id = ?');
  const t = now();
  tx(() => ordered.forEach((id, i) => st.run(i, t, id, userId)))();
  return listRules(userId);
}

function isVipSender(userId, fromAddr) {
  const a = String(fromAddr || '').toLowerCase();
  if (!a) return false;
  const rules = db.prepare('SELECT key, kind FROM sender_rules WHERE user_id = ?').all(userId);
  for (const r of rules) {
    if (r.kind !== 'vip') continue;
    const k = String(r.key || '').toLowerCase();
    if (k === a) return true;
    if (k.startsWith('@') && a.endsWith(k)) return true;
  }
  return false;
}

/** 导出供单测与调试；生产路径仍走 applyRulesForInserted */
export function matchCondition(cond, ctx) {
  const from = String(ctx.fromAddr || '').toLowerCase();
  const subject = String(ctx.subject || '');
  const snippet = String(ctx.snippet || '');
  const val = cond.value;

  switch (cond.field) {
    case 'from': {
      if (cond.op === 'is') return from === String(val).toLowerCase();
      if (cond.op === 'domain') {
        const d = String(val).toLowerCase();
        return d.startsWith('@') ? from.endsWith(d) : from.endsWith('@' + d);
      }
      if (cond.op === 'contains') return from.includes(String(val).toLowerCase()) || String(ctx.fromName || '').toLowerCase().includes(String(val).toLowerCase());
      return false;
    }
    case 'subject': {
      const s = subject.toLowerCase();
      const needle = String(val).toLowerCase();
      if (cond.op === 'contains') return s.includes(needle);
      if (cond.op === 'not_contains') return !s.includes(needle);
      return false;
    }
    case 'has_att':
      return !!ctx.hasAtt === !!val;
    case 'to_me': {
      const mine = ctx.myEmails || [];
      if (!mine.length) return false;
      const hit = [...(ctx.to || []), ...(ctx.cc || [])].some((a) => mine.includes(String(a.address || a || '').toLowerCase()));
      return !!val === hit;
    }
    case 'category':
      return String(ctx.category || '').toLowerCase() === String(val).toLowerCase();
    case 'mailbox_id':
      return String(ctx.mailboxId) === String(val);
    case 'keyword': {
      const needle = String(val).toLowerCase();
      return subject.toLowerCase().includes(needle) || snippet.toLowerCase().includes(needle);
    }
    default:
      return false;
  }
}

export function matchRule(rule, ctx) {
  const why = [];
  for (const c of rule.conditions || []) {
    if (!matchCondition(c, ctx)) return null;
    why.push(c);
  }
  return why;
}

function parseAddrs(json) {
  try {
    const a = JSON.parse(json || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/**
 * 对新插入的邮件按 position 评估规则。
 * 返回 { applied, deferred }；deferred 含需 IMAP 的副作用（flag / move）。
 */
export function applyRulesForInserted(userId, mailboxId, inserted = []) {
  if (!inserted.length) return { applied: [], deferred: [] };
  const rules = listRules(userId).filter((r) => r.enabled);
  if (!rules.length) return { applied: [], deferred: [] };

  const myEmails = db
    .prepare('SELECT lower(email) AS e FROM mailboxes WHERE user_id = ?')
    .all(userId)
    .map((r) => r.e);

  const applied = [];
  const deferred = [];
  const hitUpd = db.prepare(
    'UPDATE mail_rules SET last_hit_at = ?, last_hit_summary = ?, updated_at = updated_at WHERE id = ? AND user_id = ?'
  );

  for (const m of inserted) {
    const id = Number(m.id);
    if (!Number.isInteger(id)) continue;
    // 以库内行为准（upsert 后）
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row) continue;

    const ctx = {
      messageId: id,
      mailboxId: row.mailbox_id,
      folder: row.folder,
      uid: row.uid,
      fromAddr: row.from_addr,
      fromName: row.from_name,
      subject: row.subject,
      snippet: row.snippet,
      hasAtt: !!row.has_att,
      category: row.category,
      to: parseAddrs(row.to_json),
      cc: parseAddrs(row.cc_json),
      myEmails,
      seen: !!row.seen,
      flagged: !!row.flagged,
    };

    const whyMatched = [];
    let becameVip = isVipSender(userId, ctx.fromAddr);
    let skipRequested = false;
    let stop = false;

    for (const rule of rules) {
      const why = matchRule(rule, ctx);
      if (!why) continue;

      const actionResults = [];
      for (const action of rule.actions || []) {
        const res = runAction(userId, ctx, action, { becameVip });
        if (res) {
          actionResults.push(res);
          if (res.type === 'mark_vip') becameVip = true;
          if (res.type === 'skip_inbox') skipRequested = true;
          if (res.deferred) deferred.push(res.deferred);
        }
      }

      const summary = `${ctx.fromAddr || ''} · ${(ctx.subject || '').slice(0, 40)}`;
      hitUpd.run(now(), summary.slice(0, 160), rule.id, userId);
      whyMatched.push({
        ruleId: rule.id,
        ruleName: rule.name,
        actions: actionResults.map((a) => a.type),
      });

      if (rule.stopProcessing) {
        stop = true;
        break;
      }
    }

    // VIP 破窗：忽略 skip_inbox
    if (skipRequested && becameVip) {
      db.prepare('UPDATE messages SET skip_inbox = 0 WHERE id = ?').run(id);
    }

    if (whyMatched.length) {
      applied.push({ messageId: id, rules: whyMatched });
    }
  }

  if (applied.length) priority.invalidate(userId);
  return { applied, deferred };
}

function runAction(userId, ctx, action, { becameVip }) {
  const type = action.type;
  try {
    switch (type) {
      case 'apply_label': {
        const labelId = Number(action.params?.labelId);
        if (!Number.isInteger(labelId) || !labels.getLabel(userId, labelId)) {
          return { type, warning: '标签不存在，已跳过' };
        }
        labels.setMessageLabels(userId, [ctx.messageId], { add: [labelId] });
        return { type };
      }
      case 'mark_read': {
        if (!ctx.seen) {
          db.prepare('UPDATE messages SET seen = 1 WHERE id = ?').run(ctx.messageId);
          ctx.seen = true;
          return {
            type,
            deferred: {
              kind: 'flags',
              mailboxId: ctx.mailboxId,
              folder: ctx.folder,
              uid: ctx.uid,
              flags: { seen: true },
            },
          };
        }
        return { type };
      }
      case 'star': {
        if (!ctx.flagged) {
          db.prepare('UPDATE messages SET flagged = 1 WHERE id = ?').run(ctx.messageId);
          ctx.flagged = true;
          return {
            type,
            deferred: {
              kind: 'flags',
              mailboxId: ctx.mailboxId,
              folder: ctx.folder,
              uid: ctx.uid,
              flags: { flagged: true },
            },
          };
        }
        return { type };
      }
      case 'skip_inbox': {
        if (becameVip || isVipSender(userId, ctx.fromAddr)) {
          return { type, skipped: 'vip_breakthrough' };
        }
        db.prepare('UPDATE messages SET skip_inbox = 1 WHERE id = ?').run(ctx.messageId);
        return { type };
      }
      case 'mark_vip': {
        const key = action.params?.key || ctx.fromAddr;
        const name = action.params?.name || ctx.fromName || '';
        priority.saveRule(userId, { key, kind: 'vip', name });
        return { type };
      }
      case 'mute_sender': {
        const key = action.params?.key || ctx.fromAddr;
        const name = action.params?.name || ctx.fromName || '';
        priority.saveRule(userId, { key, kind: 'muted', name });
        return { type };
      }
      case 'move_folder': {
        const folder = String(action.params?.folder || '').trim();
        if (!folder || folder === ctx.folder) return { type, warning: '目标无效或相同' };
        const f = db.prepare('SELECT path FROM folders WHERE mailbox_id = ? AND path = ?').get(ctx.mailboxId, folder);
        if (!f) return { type, warning: '文件夹不存在，已跳过' };
        return {
          type,
          deferred: {
            kind: 'move',
            mailboxId: ctx.mailboxId,
            folder: ctx.folder,
            uid: ctx.uid,
            messageId: ctx.messageId,
            dest: folder,
          },
        };
      }
      case 'archive': {
        const arch = db
          .prepare(`SELECT path FROM folders WHERE mailbox_id = ? AND special_use = '\\Archive'`)
          .get(ctx.mailboxId);
        if (!arch) return { type, warning: '无归档文件夹' };
        if (arch.path === ctx.folder) return { type };
        return {
          type,
          deferred: {
            kind: 'move',
            mailboxId: ctx.mailboxId,
            folder: ctx.folder,
            uid: ctx.uid,
            messageId: ctx.messageId,
            dest: arch.path,
          },
        };
      }
      default:
        return null;
    }
  } catch (e) {
    return { type, warning: e.message || String(e) };
  }
}

export const CONDITION_FIELD_OPTIONS = [
  { value: 'from', label: '发件人' },
  { value: 'subject', label: '主题' },
  { value: 'has_att', label: '有附件' },
  { value: 'to_me', label: '收件人是我' },
  { value: 'category', label: '系统分类' },
  { value: 'keyword', label: '关键词' },
  { value: 'mailbox_id', label: '邮箱账号' },
];

export const ACTION_TYPE_OPTIONS = [
  { value: 'apply_label', label: '贴标签' },
  { value: 'mark_read', label: '标为已读' },
  { value: 'star', label: '加星标' },
  { value: 'skip_inbox', label: '跳过收件箱' },
  { value: 'move_folder', label: '移到文件夹' },
  { value: 'archive', label: '归档' },
  { value: 'mark_vip', label: '标为 VIP' },
  { value: 'mute_sender', label: '静音发件人' },
];
