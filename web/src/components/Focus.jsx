import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, RefreshCw, Sparkles, Loader2, Crown, CornerDownRight, Send, PartyPopper, Info, ChevronDown, Archive, Trash2, CheckCircle2, MailOpen, Hand } from 'lucide-react';
import { Row } from './MailList.jsx';
import ClaimFilter, { filterByClaim, loadClaimFilter, saveClaimFilter } from './ClaimFilter.jsx';
import { api } from '../api.js';
import { avatarColor, formatListDate, greeting, waitText } from '../utils.js';

function SectionHead({ id, title, count, hint }) {
  return (
    <div className="focus-section" id={id}>
      <b>{title}</b>
      <span className="fs-count">{count}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** 长列表分批露出：每次 +step，避免「显示其余」一次挂满数百行 */
function CapRows({ items, initial = 40, step = 40, render }) {
  const [limit, setLimit] = useState(initial);
  const itemsKey = `${items.length}:${items[0]?.id || ''}:${items[items.length - 1]?.id || ''}`;
  useEffect(() => {
    setLimit(initial);
  }, [itemsKey, initial]);
  if (!items.length) return null;
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return (
    <>
      {shown.map(render)}
      {rest > 0 && (
        <button
          type="button"
          className="focus-show-more"
          onClick={() => setLimit((n) => Math.min(items.length, n + step))}
        >
          再显示 {Math.min(step, rest)} 封（还剩 {rest}）
        </button>
      )}
    </>
  );
}

function loadExpanded() {
  try {
    const v = localStorage.getItem('zm_focus_head_expanded');
    if (v == null) return null;
    return v === '1';
  } catch {
    return null;
  }
}

export default function Focus({
  user, data, messages, loading, error, selectedId, onSelect, onAction, mailboxMap, onRefresh, refreshing, aiEnabled, onAiTriage, aiBusy,
  groupMode, setGroupMode, onFollowUp, onMuteFollow, onMenu, checked, setChecked, salesDensity = false, notify, onAiAction, aiActionBusy,
  /** 深链/旧「等待」入口：all | today | reply | overdue | follow */
  forcedBucket,
}) {
  const body = useRef();
  const reply = messages.filter((m) => m._section === 'reply');
  const follow = messages.filter((m) => m._section === 'follow');
  const stats = data?.stats;
  const sla = data?.settings?.slaHours || 24;
  const slaTier = data?.settings?.slaByTier || { vip: 4, customer: sla, inquiry: 8, default: sla };
  const followDays = data?.settings?.followDays || 3;
  const multi = Object.keys(mailboxMap).length > 1;
  const overdue = reply.filter((m) => m.priority?.overdue).length;
  const handled = stats?.handledToday || 0;
  const total = handled + reply.length;
  const pct = total ? Math.round((handled / total) * 100) : 100;

  const [headOpen, setHeadOpen] = useState(() => {
    const saved = loadExpanded();
    return saved == null ? false : saved;
  });
  const [autoOpened, setAutoOpened] = useState(false);
  const [claimFilter, setClaimFilter] = useState(() => loadClaimFilter());
  const [claimBusy, setClaimBusy] = useState(false);
  /** all | today | reply | overdue | follow — 顶部统计真正筛选列表 */
  const [bucket, setBucket] = useState(() => forcedBucket || 'all');
  const lastChecked = useRef(null);

  useEffect(() => {
    if (forcedBucket && ['all', 'today', 'reply', 'overdue', 'follow'].includes(forcedBucket)) {
      setBucket(forcedBucket);
    }
  }, [forcedBucket]);

  const filteredReply = useMemo(() => filterByClaim(reply, claimFilter), [reply, claimFilter]);
  const filteredFollow = useMemo(() => filterByClaim(follow, claimFilter), [follow, claimFilter]);
  const todayReply = useMemo(
    () => filteredReply.filter((m) => m.receivedToday || m.focusBucket === 'today'),
    [filteredReply]
  );
  const overdueReply = useMemo(
    () => filteredReply
      .filter((m) => m.isOverdue || m.priority?.overdue)
      .slice()
      .sort((a, b) => (b.priority?.waitingHours || 0) - (a.priority?.waitingHours || 0) || b.date - a.date),
    [filteredReply]
  );
  const todayDetail = data?.todayUnreplied || [];
  const overdueDetail = data?.overdueList || data?.overdueSummary?.top || [];

  /** 按 bucket 真正过滤可见列表 */
  const viewReply = useMemo(() => {
    if (bucket === 'today') return todayReply;
    if (bucket === 'overdue') return overdueReply;
    if (bucket === 'reply') return filteredReply;
    if (bucket === 'follow') return [];
    return filteredReply;
  }, [bucket, todayReply, overdueReply, filteredReply]);

  const viewToday = useMemo(
    () => (bucket === 'all' || bucket === 'today' || bucket === 'reply' ? viewReply.filter((m) => m.receivedToday || m.focusBucket === 'today') : bucket === 'overdue' ? viewReply.filter((m) => m.receivedToday) : []),
    [bucket, viewReply]
  );
  const viewOlder = useMemo(
    () => (bucket === 'all' || bucket === 'reply' ? viewReply.filter((m) => !(m.receivedToday || m.focusBucket === 'today')) : bucket === 'overdue' ? viewReply.filter((m) => !m.receivedToday) : []),
    [bucket, viewReply]
  );
  const viewFollow = useMemo(() => {
    if (bucket === 'follow' || bucket === 'all') return filteredFollow;
    return [];
  }, [bucket, filteredFollow]);

  const visibleIds = useMemo(
    () => [...viewReply.map((m) => m.id), ...viewFollow.map((m) => m.id)],
    [viewReply, viewFollow]
  );

  const BUCKET_META = {
    all: { label: '全部', hint: '今日未回 + 更早未回 + 待跟进' },
    today: { label: '今日未回', hint: '今天收到、仍待你回复的客户邮件' },
    reply: { label: '全部待回', hint: '所有仍待你回复的邮件（含今日与更早）' },
    overdue: { label: '已超时', hint: '已超过分层 SLA 仍未回复' },
    follow: { label: '待跟进', hint: '你已发出、对方尚未回复' },
  };

  const unclaimedN = reply.filter((m) => !m.deal).length + follow.filter((m) => !m.deal).length;
  const mineN = reply.filter((m) => m.deal?.mine).length + follow.filter((m) => m.deal?.mine).length;

  async function claimOne(m) {
    const address = m.from?.address;
    if (!address || claimBusy) return;
    setClaimBusy(true);
    try {
      const d = await api('/deals/claim', {
        method: 'POST',
        body: {
          address,
          threadId: m.threadId,
          messageId: m.id,
          subject: m.subject,
          fromName: m.from?.name || '',
        },
      });
      notify?.(`已认领 ${d.deal.scopeLabel}`, 'success');
      try {
        window.dispatchEvent(
          new CustomEvent('zm-deal', { detail: { dealId: d.deal?.id, reason: 'claim', deal: d.deal, messageId: m.id } })
        );
      } catch {
        /* ignore */
      }
      onRefresh?.();
    } catch (e) {
      notify?.(e.message, 'error');
      if (e.status === 409) onRefresh?.();
    } finally {
      setClaimBusy(false);
    }
  }

  async function claimSelected() {
    if (!checked?.size || claimBusy) return;
    const items = [];
    const seen = new Set();
    for (const id of checked) {
      const m = messages.find((x) => x.id === id);
      if (!m || m.deal || m._section !== 'reply') continue;
      const address = m.from?.address;
      if (!address || seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      items.push({
        address,
        threadId: m.threadId,
        messageId: m.id,
        subject: m.subject,
        fromName: m.from?.name || '',
      });
    }
    if (!items.length) {
      notify?.('所选邮件中没有未认领客户', 'info');
      return;
    }
    setClaimBusy(true);
    try {
      const r = await api('/deals/claim-batch', { method: 'POST', body: { items } });
      notify?.(
        r.skippedCount
          ? `已认领 ${r.claimedCount} 个客户，${r.skippedCount} 个跳过（可能已被同事认领）`
          : `已认领 ${r.claimedCount} 个客户`,
        r.claimedCount ? 'success' : 'info'
      );
      setChecked?.(new Set());
      try {
        window.dispatchEvent(new CustomEvent('zm-deal', { detail: { reason: 'claim-batch', count: r.claimedCount } }));
      } catch {
        /* ignore */
      }
      onRefresh?.();
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setClaimBusy(false);
    }
  }

  useEffect(() => {
    if (overdue > 0 && !autoOpened && loadExpanded() == null) {
      setHeadOpen(true);
      setAutoOpened(true);
    }
  }, [overdue, autoOpened]);

  const toggleHead = () => {
    setHeadOpen((v) => {
      const next = !v;
      try { localStorage.setItem('zm_focus_head_expanded', next ? '1' : '0'); } catch {}
      return next;
    });
  };

  /** 按客户头：预聚合计数，避免 render 内 O(n²) filter/some */
  const groupMeta = useMemo(() => {
    const map = new Map();
    for (const m of viewReply) {
      const k = m.priority?.company?.key;
      const cur = map.get(k) || { count: 0, hasToday: false };
      cur.count += 1;
      if (m.receivedToday || m.focusBucket === 'today') cur.hasToday = true;
      map.set(k, cur);
    }
    return map;
  }, [viewReply]);

  const setClaim = (v) => {
    setClaimFilter(v);
    saveClaimFilter(v);
  };

  const jump = (id) => {
    requestAnimationFrame(() => {
      body.current?.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /** 统计点击：真正筛选 + 展开详情 + 滚到对应分段 */
  const selectBucket = (key) => {
    setBucket((prev) => (prev === key ? 'all' : key));
    setHeadOpen(true);
    try { localStorage.setItem('zm_focus_head_expanded', '1'); } catch { /* ignore */ }
    const scrollId =
      key === 'today' ? 'fs-today' : key === 'overdue' ? 'fs-overdue' : key === 'follow' ? 'fs-follow' : key === 'reply' ? 'fs-reply' : null;
    if (scrollId) setTimeout(() => jump(scrollId), 80);
  };

  const openBrief = (brief) => {
    if (!brief?.id) return;
    const full = messages.find((x) => x.id === brief.id);
    if (full) onSelect?.(full);
    else onSelect?.({ id: brief.id, subject: brief.subject, from: brief.from });
  };

  const rowProps = (m, variant) => ({
    m,
    mb: mailboxMap[m.mailboxId],
    showMailbox: multi,
    selected: selectedId === m.id,
    checked: checked ? checked.has(m.id) : false,
    onSelect,
    onToggleCheck: (id, range) => {
      if (!setChecked || !checked) {
        onSelect(m);
        return;
      }
      const next = new Set(checked);
      if (range && lastChecked.current != null) {
        const a = visibleIds.indexOf(lastChecked.current);
        const b = visibleIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(visibleIds[i]);
          setChecked(next);
          return;
        }
      }
      next.has(id) ? next.delete(id) : next.add(id);
      lastChecked.current = id;
      setChecked(next);
    },
    onAction,
    variant,
    onFollowUp,
    onMuteFollow: variant === 'follow' ? onMuteFollow : undefined,
    onClaim: variant === 'reply' ? claimOne : undefined,
    claimBusy,
    onAiAction: variant === 'reply' ? onAiAction : undefined,
    aiActionBusy,
  });

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  let lastGroup = null;
  const ids = checked ? [...checked] : [];

  return (
    <section className={'list-pane focus-pane focus-craft' + (salesDensity ? ' sales-dense' : '')}>
      <header className={'focus-head compact' + (headOpen ? ' expanded' : '')}>
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>今日待办</h2>
            <small>{today} · {greeting()}，{user.name}</small>
          </div>
          {aiEnabled && reply.length > 0 && (
            <button type="button" className="ai-chip" onClick={onAiTriage} disabled={aiBusy} title="AI 逐封给出行动建议" aria-label="AI 分析待办">
              {aiBusy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} AI 分析
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onRefresh} title="全面同步所有邮箱（等待服务器完成）" aria-label="全面同步所有邮箱" disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>

        {(reply.length > 0 || follow.length > 0 || overdue > 0 || (stats?.todayUnreplied || 0) > 0) && (
          <div className={'focus-summary-bar' + (headOpen ? ' open' : '')}>
            <div className="focus-summary-stats" role="toolbar" aria-label="待办分段筛选">
              <button type="button" className={'fs-pill' + ((stats?.todayUnreplied || 0) ? ' danger' : '') + (bucket === 'today' ? ' on' : '')} onClick={() => selectBucket('today')} title="只看今天收到仍未回的">
                今日未回 <b>{stats?.todayUnreplied ?? todayReply.length}</b>
              </button>
              <button type="button" className={'fs-pill' + (bucket === 'reply' ? ' on' : '')} onClick={() => selectBucket('reply')} title="全部仍待你回复的">
                全部待回 <b>{reply.length}</b>
              </button>
              <button type="button" className={'fs-pill' + (overdue ? ' danger' : '') + (bucket === 'overdue' ? ' on' : '')} onClick={() => selectBucket('overdue')} title={`已超过 SLA（VIP ${slaTier.vip}h / 客户 ${slaTier.customer}h / 询盘 ${slaTier.inquiry}h）`}>
                已超时 <b>{overdue}</b>
              </button>
              <button type="button" className={'fs-pill' + (follow.length ? ' warn' : '') + (bucket === 'follow' ? ' on' : '')} onClick={() => selectBucket('follow')} title="你已发出、对方未回">
                待跟进 <b>{follow.length}</b>
              </button>
            </div>
            <button type="button" className="fs-expand" onClick={toggleHead} aria-expanded={headOpen} title={headOpen ? '收起明细' : '展开明细'}>
              {(overdue > 0 || (stats?.todayUnreplied || 0) > 0) && !headOpen && <span className="fs-dot-alert" aria-hidden />}
              <ChevronDown size={14} className="fs-chev" />
            </button>
          </div>
        )}

        {bucket !== 'all' && (
          <div className="focus-filter-banner" role="status">
            <Info size={13} />
            <span>
              正在查看：<b>{BUCKET_META[bucket]?.label}</b>
              （{bucket === 'follow' ? viewFollow.length : viewReply.length} 封）
              <small> · {BUCKET_META[bucket]?.hint}</small>
            </span>
            <button type="button" className="btn-ghost xs" onClick={() => setBucket('all')}>显示全部</button>
          </div>
        )}

        {headOpen && (
          <div className="focus-details">
            <div className="focus-stats" style={{ display: 'grid' }}>
              <button type="button" className={'stat' + ((stats?.todayUnreplied || 0) ? ' danger' : '') + (bucket === 'today' ? ' on' : '')} onClick={() => selectBucket('today')} aria-pressed={bucket === 'today'}>
                <b>{stats?.todayUnreplied ?? todayReply.length}</b><span>今日未回</span>
              </button>
              <button type="button" className={'stat' + (bucket === 'reply' ? ' on' : '')} onClick={() => selectBucket('reply')} aria-pressed={bucket === 'reply'}>
                <b>{reply.length}</b><span>全部待回</span>
              </button>
              <button type="button" className={'stat' + (overdue ? ' danger' : '') + (bucket === 'overdue' ? ' on' : '')} onClick={() => selectBucket('overdue')} aria-pressed={bucket === 'overdue'} title={`VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 新询盘 ${slaTier.inquiry}h`}>
                <b>{overdue}</b><span>已超时</span>
              </button>
              <button type="button" className={'stat' + (follow.length ? ' warn' : '') + (bucket === 'follow' ? ' on' : '')} onClick={() => selectBucket('follow')} aria-pressed={bucket === 'follow'}>
                <b>{follow.length}</b><span>待跟进</span>
              </button>
            </div>
            <div className={'focus-progress' + (pct === 100 && total ? ' done' : '')} title="今日已回复或标记处理的客户邮件">
              <div className="fp-bar"><i style={{ width: pct + '%' }} /></div>
              <span>今日已处理 <b>{handled}</b> / {total}{total > 0 ? <> · <b className="fp-pct">{pct}%</b></> : null} · 今日来信 <b>{stats?.todayIn ?? 0}</b>
                {stats?.olderUnreplied != null && <> · 更早未回 <b>{stats.olderUnreplied}</b></>}
              </span>
            </div>
            {(bucket === 'today' || bucket === 'all') && todayDetail.length > 0 && (
              <div className="today-unreplied-panel" aria-label="今日未回明细">
                <div className="today-unreplied-head">
                  <b>今日未回明细</b>
                  <small>共 {todayDetail.length} 封 · 今天收到仍待你回 · 点开可读信</small>
                </div>
                <ul className="today-unreplied-list">
                  {todayDetail.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={'today-unreplied-item' + (m.overdue ? ' over' : '') + (selectedId === m.id ? ' on' : '')}
                        onClick={() => openBrief(m)}
                        title={m.why || m.subject}
                      >
                        <span className="tu-badge">今日</span>
                        <span className="tu-from">{m.from?.name || m.from?.address || '未知'}</span>
                        <span className="tu-sub">{m.subject || '(无主题)'}</span>
                        <span className="tu-meta">
                          {m.overdue ? '超时' : '已等'} {waitText(m.waitingHours || 0)}
                          {m.slaHours != null && <em> / SLA {m.slaHours}h</em>}
                          <span className="tu-time">{formatListDate(m.date)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(bucket === 'overdue' || (bucket === 'all' && overdue > 0)) && overdueDetail.length > 0 && (
              <div className="today-unreplied-panel overdue-panel" aria-label="已超时明细">
                <div className="today-unreplied-head">
                  <b>已超时明细</b>
                  <small>
                    共 {overdue} 封
                    {data?.overdueSummary?.oldestHours > 0 && <> · 最早已等 {waitText(data.overdueSummary.oldestHours)}</>}
                    {stats?.overdueToday ? <> · 今日超时 {stats.overdueToday}</> : null}
                    {stats?.overdueOlder ? <> · 更早超时 {stats.overdueOlder}</> : null}
                  </small>
                </div>
                <ul className="today-unreplied-list">
                  {overdueDetail.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={'today-unreplied-item over' + (selectedId === m.id ? ' on' : '')}
                        onClick={() => openBrief(m)}
                        title={m.why || m.subject}
                      >
                        <span className="tu-badge over">{m.receivedToday ? '今日·超时' : '超时'}</span>
                        <span className="tu-from">{m.from?.name || m.from?.address || '未知'}</span>
                        <span className="tu-sub">{m.subject || '(无主题)'}</span>
                        <span className="tu-meta">
                          已等 {waitText(m.waitingHours || 0)}
                          {m.slaHours != null && <em> / SLA {m.slaHours}h</em>}
                          <span className="tu-time">{formatListDate(m.date)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {bucket === 'follow' && filteredFollow.length > 0 && (
              <div className="today-unreplied-panel follow-panel" aria-label="待跟进明细">
                <div className="today-unreplied-head">
                  <b>待跟进明细</b>
                  <small>共 {filteredFollow.length} 封 · 你已发出、对方尚未回复 · 点开可读信</small>
                </div>
                <ul className="today-unreplied-list">
                  {filteredFollow.slice(0, 40).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={'today-unreplied-item' + ((m.follow?.due || m.isOverdue) ? ' over' : '') + (selectedId === m.id ? ' on' : '')}
                        onClick={() => openBrief(m)}
                        title={m.follow?.why || m.subject}
                      >
                        <span className={'tu-badge' + ((m.follow?.due || m.isOverdue) ? ' over' : ' follow')}>
                          {m.follow?.due || m.isOverdue ? '建议跟进' : '等待中'}
                        </span>
                        <span className="tu-from">{m.to?.[0]?.name || m.to?.[0]?.address || m.from?.name || '对方'}</span>
                        <span className="tu-sub">{m.subject || '(无主题)'}</span>
                        <span className="tu-meta">
                          已等 {waitText(m.follow?.waitingHours ?? m.waitingHours ?? 0)}
                          <span className="tu-time">{formatListDate(m.date)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {bucket === 'reply' && (data?.olderUnreplied?.length || 0) > 0 && (
              <div className="today-unreplied-panel older-panel" aria-label="更早未回摘要">
                <div className="today-unreplied-head">
                  <b>更早未回</b>
                  <small>共 {stats?.olderUnreplied ?? data.olderUnreplied.length} 封 · 非今日收到仍待你回</small>
                </div>
                <ul className="today-unreplied-list">
                  {data.olderUnreplied.slice(0, 30).map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={'today-unreplied-item' + (m.overdue ? ' over' : '') + (selectedId === m.id ? ' on' : '')}
                        onClick={() => openBrief(m)}
                        title={m.why || m.subject}
                      >
                        <span className="tu-badge older">更早</span>
                        <span className="tu-from">{m.from?.name || m.from?.address || '未知'}</span>
                        <span className="tu-sub">{m.subject || '(无主题)'}</span>
                        <span className="tu-meta">
                          {m.overdue ? '超时' : '已等'} {waitText(m.waitingHours || 0)}
                          <span className="tu-time">{formatListDate(m.date)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="focus-sla-strip" title="按客户层级分层的回复时限">
              <span className="focus-sla-chip vip"><Crown size={11} /> VIP {slaTier.vip}h</span>
              <span className="focus-sla-chip">客户 {slaTier.customer}h</span>
              <span className="focus-sla-chip new">新询盘 {slaTier.inquiry}h</span>
              <span className="focus-sla-chip">跟进提醒 {followDays} 天</span>
            </div>
          </div>
        )}

        <div className="focus-tools">
          <div className="segmented">
            <button type="button" className={groupMode === 'newest' ? 'on' : ''} onClick={() => setGroupMode('newest')} title="最新来信优先，今日未回置顶">最新</button>
            <button type="button" className={groupMode === 'priority' ? 'on' : ''} onClick={() => setGroupMode('priority')} title="客户等级 × 意图 × 等待时长">优先级</button>
            <button type="button" className={groupMode === 'customer' ? 'on' : ''} onClick={() => { setGroupMode('customer'); if (bucket === 'today' || bucket === 'overdue') setBucket('reply'); }} title="按客户聚合（筛选「今日/超时」时会切到全部待回以便按客户查看）">按客户</button>
          </div>
          <ClaimFilter value={claimFilter} onChange={setClaim} unclaimedN={unclaimedN} mineN={mineN} />
          <span
            className="focus-legend"
            title={`今日未回=今天收到仍待你回；全部待回=所有待你回；已超时=超过分层 SLA；待跟进=你发出对方未回。点上方数字可筛选列表。`}
          >
            <Info size={12} /> 点数字可筛选
          </span>
        </div>

        {checked && checked.size > 0 && (
          <div className="bulk" style={{ padding: '0 0 2px' }}>
            <span>已选 {checked.size}</span>
            <button type="button" title="批量认领未跟客户" aria-label="批量认领" disabled={claimBusy} onClick={claimSelected}>
              {claimBusy ? <Loader2 size={15} className="spin" /> : <Hand size={15} />}
            </button>
            <button type="button" title="标为已读" aria-label="标为已读" onClick={() => onAction(ids, 'read')}><MailOpen size={15} /></button>
            <button type="button" title="归档" aria-label="归档" onClick={() => onAction(ids, 'archive')}><Archive size={15} /></button>
            <button type="button" title="删除" aria-label="删除" onClick={() => onAction(ids, 'trash')}><Trash2 size={15} /></button>
            <button type="button" title="无需回复" aria-label="无需回复" onClick={() => onAction(ids, 'done')}><CheckCircle2 size={15} /></button>
            <button type="button" className="text" onClick={() => setChecked(new Set())}>取消</button>
          </div>
        )}
      </header>

      <div className="list-body" ref={body}>
        {error && <div className="list-error">{error}</div>}
        {loading && !messages.length && (
          <div className="skeletons">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton-row"><div className="sk-avatar" /><div className="sk-lines"><div /><div /><div /></div></div>
            ))}
          </div>
        )}

        {!loading && !error && data && !reply.length && !follow.length && (
          <div className="empty focus-empty">
            <PartyPopper size={42} strokeWidth={1.2} />
            <p>全部处理完了</p>
            <small>没有等待你回复的客户邮件，也没有需要跟进的报价。</small>
            <div className="focus-empty-stats">
              <span>今日已处理 <b>{handled}</b></span>
              <span className="dot">·</span>
              <span>今日来信 <b>{stats?.todayIn ?? 0}</b></span>
              {handled > 0 && (
                <>
                  <span className="dot">·</span>
                  <span className="focus-empty-pct">进度 {pct}%</span>
                </>
              )}
            </div>
            <button type="button" className="btn-ghost sm" onClick={onRefresh} disabled={refreshing} style={{ marginTop: 10 }}>
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> {refreshing ? '同步中…' : '同步邮箱'}
            </button>
            <small className="focus-empty-hint">智能分诊仍在后台工作 · 按 <kbd>J</kbd>/<kbd>K</kbd> 巡航 · <kbd>G</kbd> 再 <kbd>T</kbd> 随时回到此处</small>
          </div>
        )}

        {!loading && !error && data && reply.length > 0 && !filteredReply.length && (
          <div className="empty focus-empty sm">
            <p>当前认领筛选下没有待回复邮件</p>
            <button type="button" className="btn-ghost sm" onClick={() => setClaim('all')}>查看全部</button>
          </div>
        )}

        {!loading && !error && data && bucket !== 'all' && !viewReply.length && !viewFollow.length && (reply.length > 0 || follow.length > 0) && (
          <div className="empty focus-empty sm">
            <p>「{BUCKET_META[bucket]?.label}」暂无邮件</p>
            <small>{BUCKET_META[bucket]?.hint}</small>
            <button type="button" className="btn-ghost sm" onClick={() => setBucket('all')} style={{ marginTop: 8 }}>显示全部待办</button>
          </div>
        )}

        {/* 超时筛选：单独一段，按等待时长（服务端已排） */}
        {groupMode !== 'customer' && bucket === 'overdue' && viewReply.length > 0 && (
          <>
            <SectionHead
              id="fs-overdue"
              title="已超时"
              count={viewReply.length}
              hint={`超过分层 SLA 仍未回 · VIP ${slaTier.vip}h / 客户 ${slaTier.customer}h / 询盘 ${slaTier.inquiry}h`}
            />
            <CapRows items={viewReply} render={(m) => <Row key={m.id} {...rowProps(m, 'reply')} />} />
          </>
        )}

        {groupMode !== 'customer' && bucket !== 'overdue' && viewToday.length > 0 && (
          <SectionHead
            id="fs-today"
            title="今日未回"
            count={viewToday.length}
            hint="今天收到、仍待你回复 · 按最新排列"
          />
        )}
        {groupMode !== 'customer' && bucket !== 'overdue' && (
          <CapRows items={viewToday} render={(m) => <Row key={m.id} {...rowProps(m, 'reply')} />} />
        )}

        {groupMode !== 'customer' && bucket !== 'overdue' && viewOlder.length > 0 && (
          <SectionHead
            id="fs-reply"
            title={bucket === 'reply' ? '全部待回 · 更早' : '更早未回'}
            count={viewOlder.length}
            hint={claimFilter !== 'all' && claimFilter !== 'active' ? `筛选后 ${viewOlder.length}` : `VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 询盘 ${slaTier.inquiry}h`}
          />
        )}
        {groupMode !== 'customer' && bucket !== 'overdue' && (
          <CapRows items={viewOlder} render={(m) => <Row key={m.id} {...rowProps(m, 'reply')} />} />
        )}

        {groupMode === 'customer' && viewReply.length > 0 && (
          <SectionHead
            id={bucket === 'overdue' ? 'fs-overdue' : 'fs-reply'}
            title={bucket === 'overdue' ? '已超时（按客户）' : '需要你回复'}
            count={viewReply.length}
            hint={claimFilter === 'active' ? `跟进中 ${viewReply.length}` : `按客户聚合 · 共 ${viewReply.length} 封`}
          />
        )}
        {groupMode === 'customer' && (
          <CapRows
            items={viewReply}
            initial={50}
            render={(m) => {
              const k = m.priority.company?.key;
              const head = k !== lastGroup;
              lastGroup = k;
              return (
                <React.Fragment key={m.id}>
                  {head && (
                    <div className="cust-head">
                      <span className="cust-avatar" style={{ background: avatarColor(k) }}>{(m.priority.company?.name || '?').slice(0, 1).toUpperCase()}</span>
                      <b>{m.priority.company?.name}</b>
                      {m.priority.tier === 'vip' && <Crown size={12} className="vip-icon" />}
                      {m.priority.company?.domain && <small>{m.priority.company.domain}</small>}
                      <span className="cust-count">{groupMeta.get(k)?.count || 0} 封</span>
                      {groupMeta.get(k)?.hasToday && <span className="cust-today-tag">含今日</span>}
                    </div>
                  )}
                  <Row {...rowProps(m, 'reply')} />
                </React.Fragment>
              );
            }}
          />
        )}

        {viewFollow.length > 0 && (
          <SectionHead
            id="fs-follow"
            title="等待对方回复"
            count={viewFollow.length}
            hint={
              claimFilter !== 'all'
                ? `筛选后 ${viewFollow.length}/${follow.length}`
                : `已发未回（满 ${followDays} 天标「建议跟进」）`
            }
          />
        )}
        {!loading && !error && data && follow.length > 0 && !filteredFollow.length && claimFilter !== 'all' && !filteredReply.length && bucket === 'all' && (
          <div className="empty focus-empty sm">
            <p>当前认领筛选下没有待跟进邮件</p>
            <button type="button" className="btn-ghost sm" onClick={() => setClaim('all')}>查看全部</button>
          </div>
        )}
        <CapRows items={viewFollow} render={(m) => <Row key={m.id} {...rowProps(m, 'follow')} />} />

        {(viewReply.length > 0 || viewFollow.length > 0) && (
          <div className="focus-foot">
            <CornerDownRight size={12} /> 回复后自动移出列表 · 不需要回复的点 <b>✓</b> 标记处理 · 报价发出后对方无回音会出现在<Send size={11} />「待跟进」
          </div>
        )}
      </div>
    </section>
  );
}
