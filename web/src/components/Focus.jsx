import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, RefreshCw, Sparkles, Loader2, Crown, CornerDownRight, Send, PartyPopper, Info, AlertTriangle, ChevronDown, Archive, Trash2, CheckCircle2, MailOpen, Hand } from 'lucide-react';
import { Row } from './MailList.jsx';
import ClaimFilter, { filterByClaim, loadClaimFilter, saveClaimFilter } from './ClaimFilter.jsx';
import { api } from '../api.js';
import { avatarColor, greeting, waitText } from '../utils.js';

function SectionHead({ id, title, count, hint }) {
  return (
    <div className="focus-section" id={id}>
      <b>{title}</b>
      <span className="fs-count">{count}</span>
      {hint && <small>{hint}</small>}
    </div>
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
  groupMode, setGroupMode, onFollowUp, onMenu, checked, setChecked, salesDensity = false, notify,
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

  const filteredReply = useMemo(() => filterByClaim(reply, claimFilter), [reply, claimFilter]);
  const filteredFollow = useMemo(() => filterByClaim(follow, claimFilter), [follow, claimFilter]);

  const unclaimedN = reply.filter((m) => !m.deal).length + follow.filter((m) => !m.deal).length;
  const mineN = reply.filter((m) => m.deal?.mine).length + follow.filter((m) => m.deal?.mine).length;

  async function claimOne(m) {
    const address = m.from?.address;
    if (!address || claimBusy) return;
    setClaimBusy(true);
    try {
      const d = await api('/deals/claim', {
        method: 'POST',
        body: { address, threadId: m.threadId },
      });
      notify?.(`已认领 ${d.deal.scopeLabel}`, 'success');
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
      items.push({ address, threadId: m.threadId });
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

  const groupSizes = useMemo(() => {
    const map = new Map();
    for (const m of filteredReply) {
      const k = m.priority.company?.key;
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }, [filteredReply]);

  const setClaim = (v) => {
    setClaimFilter(v);
    saveClaimFilter(v);
  };

  const jump = (id) => body.current?.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

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
      if (range) {
        const ids = messages.map((x) => x.id);
        const a = ids.indexOf([...checked][checked.size - 1]);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
          setChecked(next);
          return;
        }
      }
      next.has(id) ? next.delete(id) : next.add(id);
      setChecked(next);
    },
    onAction,
    variant,
    onFollowUp,
    onClaim: variant === 'reply' ? claimOne : undefined,
    claimBusy,
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
          <button type="button" className="icon-btn" onClick={onRefresh} title="同步所有邮箱" aria-label="同步所有邮箱">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>

        {(reply.length > 0 || follow.length > 0 || overdue > 0) && (
          <button
            type="button"
            className={'focus-summary' + (headOpen ? ' open' : '')}
            onClick={toggleHead}
            aria-expanded={headOpen}
            aria-label={`待回复 ${reply.length} 封，超时 ${overdue} 封，跟进 ${follow.length} 封，今日来信 ${stats?.todayIn ?? 0}`}
          >
            {overdue > 0 && !headOpen && <span className="fs-dot-alert" aria-hidden />}
            <span>待回 <b>{reply.length}</b></span>
            <span className="fs-dot">·</span>
            <span className={overdue ? 'fs-danger' : ''}>超时 <b>{overdue}</b></span>
            <span className="fs-dot">·</span>
            <span className={follow.length ? 'fs-warn' : ''}>跟进 <b>{follow.length}</b></span>
            <span className="fs-dot">·</span>
            <span>今日来信 <b>{stats?.todayIn ?? 0}</b></span>
            <ChevronDown size={14} className="fs-chev" />
          </button>
        )}

        {headOpen && (
          <div className="focus-details">
            <div className="focus-stats" style={{ display: 'grid' }}>
              <button type="button" className="stat" onClick={() => jump('fs-reply')} aria-label={`待回复 ${reply.length} 封`}>
                <b>{reply.length}</b><span>待回复</span>
              </button>
              <button type="button" className={'stat' + (overdue ? ' danger' : '')} onClick={() => jump('fs-reply')} aria-label={`已超时 ${overdue} 封`} title={`分层时限：VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 新询盘 ${slaTier.inquiry}h`}>
                <b>{overdue}</b><span>已超时</span>
              </button>
              <button type="button" className={'stat' + (follow.length ? ' warn' : '')} onClick={() => jump('fs-follow')} aria-label={`待跟进 ${follow.length} 封`}>
                <b>{follow.length}</b><span>待跟进</span>
              </button>
              <div className="stat plain">
                <b>{stats?.todayIn ?? 0}</b><span>今日来信</span>
              </div>
            </div>
            <div className={'focus-progress' + (pct === 100 && total ? ' done' : '')} title="今日已回复或标记处理的客户邮件">
              <div className="fp-bar"><i style={{ width: pct + '%' }} /></div>
              <span>今日已处理 <b>{handled}</b> / {total}{total > 0 ? <> · <b className="fp-pct">{pct}%</b></> : null}</span>
            </div>
            <div className="focus-sla-strip" title="按客户层级分层的回复时限">
              <span className="focus-sla-chip vip"><Crown size={11} /> VIP {slaTier.vip}h</span>
              <span className="focus-sla-chip">客户 {slaTier.customer}h</span>
              <span className="focus-sla-chip new">新询盘 {slaTier.inquiry}h</span>
            </div>
            {overdue > 0 && data?.overdueSummary && (
              <button type="button" className="overdue-summary" onClick={() => jump('fs-reply')} title="跳转到超时待回复">
                <AlertTriangle size={14} />
                <span>
                  <b>{overdue}</b> 封已超时
                  {data.overdueSummary.oldestHours > 0 && <> · 最早已等 {waitText(data.overdueSummary.oldestHours)}</>}
                  {data.overdueSummary.byTier?.vip > 0 && <> · VIP {data.overdueSummary.byTier.vip}</>}
                </span>
                <small>去处理</small>
              </button>
            )}
          </div>
        )}

        <div className="focus-tools">
          <div className="segmented">
            <button type="button" className={groupMode !== 'customer' ? 'on' : ''} onClick={() => setGroupMode('priority')}>按优先级</button>
            <button type="button" className={groupMode === 'customer' ? 'on' : ''} onClick={() => setGroupMode('customer')}>按客户</button>
          </div>
          <ClaimFilter value={claimFilter} onChange={setClaim} unclaimedN={unclaimedN} mineN={mineN} />
          <span className="focus-legend" title={`排序依据：客户等级 × 意图 × 等待时长。分层 SLA：VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 新询盘 ${slaTier.inquiry}h · 默认 ${slaTier.default}h`}>
            <Info size={12} /> 智能排序
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
            <small className="focus-empty-hint">智能分诊仍在后台工作 · 按 <kbd>J</kbd>/<kbd>K</kbd> 巡航 · <kbd>G</kbd> 再 <kbd>T</kbd> 随时回到此处</small>
          </div>
        )}

        {filteredReply.length > 0 && (
          <SectionHead
            id="fs-reply"
            title="需要你回复"
            count={filteredReply.length}
            hint={claimFilter !== 'all' ? `筛选后 ${filteredReply.length}/${reply.length}` : `VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 询盘 ${slaTier.inquiry}h`}
          />
        )}
        {!loading && !error && data && reply.length > 0 && !filteredReply.length && (
          <div className="empty focus-empty sm">
            <p>当前筛选下没有待回复邮件</p>
            <button type="button" className="btn-ghost sm" onClick={() => setClaim('all')}>查看全部</button>
          </div>
        )}
        {filteredReply.map((m) => {
          const k = m.priority.company?.key;
          const head = groupMode === 'customer' && k !== lastGroup;
          lastGroup = k;
          return (
            <React.Fragment key={m.id}>
              {head && (
                <div className="cust-head">
                  <span className="cust-avatar" style={{ background: avatarColor(k) }}>{(m.priority.company?.name || '?').slice(0, 1).toUpperCase()}</span>
                  <b>{m.priority.company?.name}</b>
                  {m.priority.tier === 'vip' && <Crown size={12} className="vip-icon" />}
                  {m.priority.company?.domain && <small>{m.priority.company.domain}</small>}
                  <span className="cust-count">{groupSizes.get(k)} 封</span>
                </div>
              )}
              <Row {...rowProps(m, 'reply')} />
            </React.Fragment>
          );
        })}

        {filteredFollow.length > 0 && (
          <SectionHead
            id="fs-follow"
            title="等待对方回复"
            count={filteredFollow.length}
            hint={claimFilter !== 'all' ? `筛选后 ${filteredFollow.length}/${follow.length}` : `发出 ${followDays} 天以上仍无回音`}
          />
        )}
        {!loading && !error && data && follow.length > 0 && !filteredFollow.length && claimFilter !== 'all' && !filteredReply.length && (
          <div className="empty focus-empty sm">
            <p>当前筛选下没有待跟进邮件</p>
            <button type="button" className="btn-ghost sm" onClick={() => setClaim('all')}>查看全部</button>
          </div>
        )}
        {filteredFollow.map((m) => <Row key={m.id} {...rowProps(m, 'follow')} />)}

        {(reply.length > 0 || follow.length > 0) && (
          <div className="focus-foot">
            <CornerDownRight size={12} /> 回复后自动移出列表 · 不需要回复的点 <b>✓</b> 标记处理 · 报价发出后对方无回音会出现在<Send size={11} />「待跟进」
          </div>
        )}
      </div>
    </section>
  );
}
