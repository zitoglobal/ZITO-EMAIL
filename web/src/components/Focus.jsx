import React, { useMemo, useRef } from 'react';
import { Menu, RefreshCw, Sparkles, Loader2, Crown, CornerDownRight, Send, PartyPopper, Info, AlertTriangle } from 'lucide-react';
import { Row } from './MailList.jsx';
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

export default function Focus({
  user, data, messages, loading, error, selectedId, onSelect, onAction, mailboxMap, onRefresh, refreshing, aiEnabled, onAiTriage, aiBusy,
  groupMode, setGroupMode, onFollowUp, onMenu,
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

  const groupSizes = useMemo(() => {
    const map = new Map();
    for (const m of reply) {
      const k = m.priority.company?.key;
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }, [reply]);

  const jump = (id) => body.current?.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const rowProps = (m, variant) => ({
    m,
    mb: mailboxMap[m.mailboxId],
    showMailbox: multi,
    selected: selectedId === m.id,
    checked: false,
    onSelect,
    onToggleCheck: () => onSelect(m),
    onAction,
    variant,
    onFollowUp,
  });

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  let lastGroup = null;

  return (
    <section className="list-pane focus-pane focus-craft">
      <header className="focus-head">
        <div className="list-title-row">
          <button className="icon-btn mobile-only" onClick={onMenu}><Menu size={18} /></button>
          <div className="list-title">
            <h2>今日待办</h2>
            <small>{today} · {greeting()}，{user.name}</small>
          </div>
          {aiEnabled && reply.length > 0 && (
            <button className="ai-chip" onClick={onAiTriage} disabled={aiBusy} title="AI 逐封给出行动建议">
              {aiBusy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} AI 分析
            </button>
          )}
          <button className="icon-btn" onClick={onRefresh} title="同步所有邮箱">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>

        <div className="focus-stats">
          <button className="stat" onClick={() => jump('fs-reply')}>
            <b>{reply.length}</b><span>待回复</span>
          </button>
          <button className={'stat' + (overdue ? ' danger' : '')} onClick={() => jump('fs-reply')} title={`分层时限：VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 新询盘 ${slaTier.inquiry}h`}>
            <b>{overdue}</b><span>已超时</span>
          </button>
          <button className={'stat' + (follow.length ? ' warn' : '')} onClick={() => jump('fs-follow')}>
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

        <div className="focus-tools">
          <div className="segmented">
            <button className={groupMode !== 'customer' ? 'on' : ''} onClick={() => setGroupMode('priority')}>按优先级</button>
            <button className={groupMode === 'customer' ? 'on' : ''} onClick={() => setGroupMode('customer')}>按客户</button>
          </div>
          <span className="focus-legend" title={`排序依据：客户等级 × 意图 × 等待时长。分层 SLA：VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 新询盘 ${slaTier.inquiry}h · 默认 ${slaTier.default}h`}>
            <Info size={12} /> 智能排序
          </span>
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
            <small>点击处理</small>
          </button>
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

        {reply.length > 0 && (
          <SectionHead id="fs-reply" title="需要你回复" count={reply.length} hint={`VIP ${slaTier.vip}h · 客户 ${slaTier.customer}h · 询盘 ${slaTier.inquiry}h`} />
        )}
        {reply.map((m) => {
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

        {follow.length > 0 && (
          <SectionHead id="fs-follow" title="等待对方回复" count={follow.length} hint={`发出 ${followDays} 天以上仍无回音`} />
        )}
        {follow.map((m) => <Row key={m.id} {...rowProps(m, 'follow')} />)}

        {(reply.length > 0 || follow.length > 0) && (
          <div className="focus-foot">
            <CornerDownRight size={12} /> 回复后自动移出列表 · 不需要回复的点 <b>✓</b> 标记处理 · 报价发出后对方无回音会出现在<Send size={11} />「待跟进」
          </div>
        )}
      </div>
    </section>
  );
}
