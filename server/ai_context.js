/**
 * 为 AI 回复/分诊注入业务状态（阶段、认领、SLA、信号）。
 */
import * as deals from './deals.js';
import { slaFor, tierOf, relationIndex } from './priority.js';

const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事' };
const SIG_TEXT = {
  urgent: '紧急',
  complaint: '投诉',
  order: '订单',
  payment: '付款',
  inquiry: '询盘',
  sample: '样品',
  fabric: '面料',
  fit: '尺码/合体',
  shipping: '物流',
  question: '有提问',
};

const STAGE_HINT = {
  inquiry: '询盘阶段（成衣）：确认用途、面料成分/克重、颜色尺码、目标价与贸易术语、交期窗口；可要 tech pack，勿编造价格。',
  quote: '报价中：围绕单价/MOQ/交期/付款条件答疑，主动给可调空间，推动确认或寄样（SMS/色卡）。',
  sample: '样品阶段：区分 SMS/Fit/PP/产前样；围绕反馈、修改与大货意向数量回复，确认快递与批准节点。',
  bulk: '大货阶段：锁定 PO 数量配码、批准样、包装唛头与船期，推动出 PI / 下线。',
  payment: '付款阶段：礼貌确认 PI/定金/水单，说明到账后排产，不施压。',
  won: '已成交：确认出货文件/验货，可轻提返单或下一季开发。',
  lost: '丢单或停滞：语气克制，可问原因并表示仍可协助，不强推报价。',
};

/**
 * @param {number} userId
 * @param {object} row messages 行或轻量 { from_addr, date, subject, snippet, signals, thread_id, category }
 * @param {object} [settings]
 */
export function bizContextForRow(userId, row, settings = {}) {
  if (!row) return null;
  const addr = row.from_addr || row.from?.address || '';
  const lookup = deals.lookup(userId, { address: addr, threadId: row.thread_id || row.threadId });
  const deal = lookup.deal;
  const idx = relationIndex(userId);
  const signals =
    row.signals != null
      ? typeof row.signals === 'string'
        ? row.signals
          ? row.signals.split(',')
          : []
        : Array.isArray(row.signals)
          ? row.signals
          : []
      : [];
  const tier = tierOf(idx, addr, row.category);
  const slaHours = slaFor(settings, tier, signals);
  const at = Date.now();
  const waitingHours = row.date ? Math.round(((at - row.date) / 3600_000) * 10) / 10 : null;
  const overdue = waitingHours != null && waitingHours >= slaHours;
  const styles = deal?.id ? deals.listStyles(deal.id).slice(0, 6) : [];
  const styleLines = styles.map((s) => {
    const bits = [s.styleNo];
    if (s.colorway) bits.push(s.colorway);
    if (s.unitPrice != null) bits.push(`${s.currency || deal.currency || 'USD'} ${s.unitPrice}`);
    if (s.moq) bits.push(`MOQ ${s.moq}`);
    return bits.filter(Boolean).join(' / ');
  });
  return {
    address: addr,
    tier,
    tierLabel: TIER_TEXT[tier] || tier,
    signals,
    signalLabels: signals.map((s) => SIG_TEXT[s] || s).filter(Boolean),
    slaHours,
    waitingHours,
    overdue,
    stage: deal?.stage || null,
    stageLabel: deal?.stageLabel || null,
    dealMine: !!deal?.mine,
    dealOwner: deal && !deal.mine ? deal.owner?.name || deal.owner?.email || '同事' : deal?.mine ? '我' : null,
    unclaimed: !deal,
    stageHint: deal?.stage ? STAGE_HINT[deal.stage] || null : STAGE_HINT.inquiry,
    styleNo: deal?.styleNo || '',
    currency: deal?.currency || 'USD',
    amount: deal?.amount ?? null,
    moq: deal?.moq || '',
    leadDays: deal?.leadDays ?? null,
    incoterm: deal?.incoterm || '',
    quoteValidUntil: deal?.quoteValidUntil || null,
    styleLines,
  };
}

/** 拼进 prompt 的中文业务块 */
export function formatBizContext(ctx) {
  if (!ctx) return '';
  const lines = [];
  if (ctx.stageLabel) lines.push(`业务阶段：${ctx.stageLabel}`);
  else lines.push('业务阶段：尚未建档（可按询盘处理）');
  if (ctx.dealMine) lines.push('认领：我跟进');
  else if (ctx.dealOwner) lines.push(`认领：${ctx.dealOwner}（注意勿撞单）`);
  else lines.push('认领：公海未认领');
  if (ctx.tierLabel) lines.push(`客户档位：${ctx.tierLabel}`);
  if (ctx.waitingHours != null) {
    lines.push(`已等待：${ctx.waitingHours}h（SLA ${ctx.slaHours}h）${ctx.overdue ? ' · 已超时，语气可更主动但仍专业' : ''}`);
  }
  if (ctx.signalLabels?.length) lines.push(`业务信号：${ctx.signalLabels.join('、')}`);
  if (ctx.styleLines?.length) lines.push(`款号报价：${ctx.styleLines.join('；')}`);
  else if (ctx.styleNo) lines.push(`主款号：${ctx.styleNo}`);
  const commerceBits = [];
  if (ctx.amount != null) commerceBits.push(`${ctx.currency || 'USD'} ${ctx.amount}`);
  if (ctx.moq) commerceBits.push(`MOQ ${ctx.moq}`);
  if (ctx.leadDays != null) commerceBits.push(`交期 ${ctx.leadDays} 天`);
  if (ctx.incoterm) commerceBits.push(ctx.incoterm);
  if (ctx.quoteValidUntil) {
    commerceBits.push(`有效至 ${new Date(ctx.quoteValidUntil).toLocaleDateString('en-CA')}`);
  }
  if (commerceBits.length) lines.push(`成交要点：${commerceBits.join(' · ')}`);
  if (ctx.stageHint) lines.push(`阶段建议：${ctx.stageHint}`);
  return `\n\n【业务上下文 — 撰写时必须遵守，勿编造上下文中没有的事实】\n${lines.join('\n')}`;
}

/** 给 triage 用的单行摘要 */
export function triageContextLine(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.stageLabel) parts.push(`阶段=${ctx.stageLabel}`);
  if (ctx.dealMine) parts.push('我跟');
  else if (ctx.dealOwner) parts.push(`同事跟=${ctx.dealOwner}`);
  else parts.push('未认领');
  if (ctx.tierLabel) parts.push(ctx.tierLabel);
  if (ctx.overdue) parts.push('已超时');
  else if (ctx.waitingHours != null) parts.push(`已等${ctx.waitingHours}h`);
  if (ctx.signalLabels?.length) parts.push(ctx.signalLabels.slice(0, 2).join('/'));
  return parts.join(' · ');
}

const STAGE_IDS = new Set(deals.STAGES.map((s) => s.id));

/** 校验并裁剪模型返回的动作 */
export function normalizeTriageActions(raw, ctx = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const type = String(a.type || '').toLowerCase();
    if (!['claim', 'stage', 'snooze', 'reply', 'followup', 'done'].includes(type)) continue;
    if (type === 'claim' && (ctx.dealMine || (ctx.dealOwner && !ctx.unclaimed))) continue;
    if (type === 'stage') {
      const stage = String(a.stage || '');
      if (!STAGE_IDS.has(stage) || stage === 'lost') continue;
      if (ctx.stage === stage) continue;
    }
    const key = type + (type === 'stage' ? ':' + a.stage : '');
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { type };
    if (type === 'stage') {
      item.stage = String(a.stage);
      item.label = String(a.label || `推进到${deals.stageMeta(item.stage).label}`).slice(0, 24);
    } else if (type === 'snooze') {
      const hours = Math.min(72, Math.max(1, Number(a.hours) || 4));
      item.hours = hours;
      item.label = String(a.label || `${hours}小时后再看`).slice(0, 24);
    } else if (type === 'reply' || type === 'followup') {
      item.instruction = String(a.instruction || a.label || '').slice(0, 200);
      item.label = String(a.label || (type === 'followup' ? '写催单' : '写回复')).slice(0, 24);
    } else if (type === 'claim') {
      item.label = String(a.label || '认领客户').slice(0, 24);
    } else if (type === 'done') {
      item.label = String(a.label || '标记已处理').slice(0, 24);
    }
    out.push(item);
    if (out.length >= 3) break;
  }
  // 未认领时保证至少有认领入口（模型漏了也补）
  if (ctx.unclaimed && !out.some((x) => x.type === 'claim') && out.length < 3) {
    out.unshift({ type: 'claim', label: '认领客户' });
  }
  return out.slice(0, 3);
}
