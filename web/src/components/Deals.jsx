import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Menu, RefreshCw, Briefcase, Loader2, CalendarClock, Mail, Send } from 'lucide-react';
import { api, qs } from '../api.js';
import { stageChecklist } from '../apparelPresets.js';
import { formatShortDateTime } from '../utils.js';

function followPresets() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  const day = (n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x.getTime();
  };
  return [
    { label: '明天', at: day(1) },
    { label: '3天', at: day(3) },
    { label: '一周', at: day(7) },
  ];
}

/**
 * 「我的客户」轻列表 — 按业务阶段扫管线（邮箱内 deals，非独立 CRM）
 */
export default function Deals({ onMenu, notify, onOpenDeal, onOpenDealMail, onComposeOutreach }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [deals, setDeals] = useState([]);
  const [stages, setStages] = useState([]);
  const [owner, setOwner] = useState('mine');
  const [stage, setStage] = useState('all');
  const [followFilter, setFollowFilter] = useState('all'); // all | due | planned
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const d = await api(
        '/deals' +
          qs({
            owner,
            stage: stage === 'all' ? undefined : stage,
            limit: 150,
          })
      );
      setDeals(d.deals || []);
      setStages(d.stages || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [owner, stage]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onBump = () => load(true);
    window.addEventListener('zm-deal', onBump);
    window.addEventListener('zm-collab', onBump);
    return () => {
      window.removeEventListener('zm-deal', onBump);
      window.removeEventListener('zm-collab', onBump);
    };
  }, [load]);

  const followCounts = useMemo(() => {
    const at = Date.now();
    let due = 0;
    let planned = 0;
    for (const d of deals) {
      if (!d.nextFollowAt) continue;
      if (d.nextFollowAt <= at) due++;
      else planned++;
    }
    return { due, planned, at };
  }, [deals]);

  const counts = useMemo(() => {
    const map = { all: deals.length };
    for (const s of stages) map[s.id] = 0;
    for (const d of deals) map[d.stage] = (map[d.stage] || 0) + 1;
    return map;
  }, [deals, stages]);

  const visible = useMemo(() => {
    const at = followCounts.at || Date.now();
    let list = deals;
    if (followFilter === 'due') list = list.filter((d) => d.nextFollowAt && d.nextFollowAt <= at);
    else if (followFilter === 'planned') list = list.filter((d) => d.nextFollowAt && d.nextFollowAt > at);
    return list;
  }, [deals, followFilter, followCounts.at]);

  async function setDealStage(deal, next) {
    if (!deal?.id || next === deal.stage) return;
    setBusyId(deal.id);
    try {
      const r = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { stage: next } });
      setDeals((list) => list.map((x) => (x.id === deal.id ? r.deal : x)));
      notify?.(`已更新为 ${r.deal.stageLabel}`);
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function setFollowAt(deal, ts) {
    if (!deal?.id) return;
    setBusyId(deal.id);
    try {
      const r = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { nextFollowAt: ts } });
      setDeals((list) => list.map((x) => (x.id === deal.id ? r.deal : x)));
      notify?.(ts ? `下次跟进：${formatShortDateTime(ts)}` : '已清除跟进日');
    } catch (e) {
      notify?.(e.message, 'error');
      load(true);
    } finally {
      setBusyId(null);
    }
  }

  function openDeal(d) {
    if (d.lastMessageId && onOpenDealMail) {
      onOpenDealMail(d.lastMessageId, d);
      return;
    }
    onOpenDeal?.(d);
  }

  function writeFollow(d) {
    if (!d.lastAddress || !onComposeOutreach) return;
    onComposeOutreach({
      to: d.lastAddress,
      subject: d.scopeLabel ? `Re: ${d.scopeLabel}` : '',
      openAi: true,
      aiInstruction: `写一封专业的跟进邮件给 ${d.scopeLabel || d.lastAddress}（阶段：${d.stageLabel || '跟进中'}）。礼貌询问进展，勿编造报价或交期。`,
    });
  }

  return (
    <section className="list-pane deals-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>我的客户</h2>
            <small>
              认领管线 · 到期置顶 · 可开线索
              {followCounts.due > 0 ? ` · ${followCounts.due} 条到期` : ''}
            </small>
          </div>
          <button type="button" className="icon-btn" onClick={() => load(true)} title="刷新" aria-label="刷新">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
        <div className="segmented claim-filter" title="归属">
          <button type="button" className={owner === 'mine' ? 'on' : ''} onClick={() => setOwner('mine')}>我跟</button>
          <button type="button" className={owner === 'all' ? 'on' : ''} onClick={() => setOwner('all')}>全部</button>
          <button type="button" className={owner === 'others' ? 'on' : ''} onClick={() => setOwner('others')}>同事</button>
        </div>
        <div className="segmented claim-filter" title="跟进日">
          <button type="button" className={followFilter === 'all' ? 'on' : ''} onClick={() => setFollowFilter('all')}>
            全部
          </button>
          <button type="button" className={followFilter === 'due' ? 'on' : ''} onClick={() => setFollowFilter('due')}>
            <CalendarClock size={12} /> 已到期 {followCounts.due || ''}
          </button>
          <button type="button" className={followFilter === 'planned' ? 'on' : ''} onClick={() => setFollowFilter('planned')}>
            有跟进日 {followCounts.planned || ''}
          </button>
        </div>
        <div className="deals-stage-tabs" role="tablist">
          <button type="button" className={stage === 'all' ? 'on' : ''} onClick={() => setStage('all')}>
            全部 {counts.all || ''}
          </button>
          {stages.map((s) => (
            <button
              key={s.id}
              type="button"
              className={stage === s.id ? 'on' : ''}
              style={stage === s.id ? { borderColor: s.color, color: s.color } : undefined}
              onClick={() => setStage(s.id)}
            >
              {s.label}{counts[s.id] ? ` ${counts[s.id]}` : ''}
            </button>
          ))}
        </div>
      </header>

      <div className="list-body">
        {error && <div className="list-error">{error}</div>}
        {loading && !deals.length && (
          <div className="skeletons">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton-row"><div className="sk-avatar" /><div className="sk-lines"><div /><div /></div></div>
            ))}
          </div>
        )}
        {!loading && !error && !visible.length && (
          <div className="empty">
            <Briefcase size={42} strokeWidth={1.2} />
            <p>
              {followFilter === 'due'
                ? '没有到期跟进'
                : followFilter === 'planned'
                  ? '没有已设跟进日的客户'
                  : '还没有认领客户'}
            </p>
            <small>
              {followFilter !== 'all'
                ? '切换筛选或去今日待办处理'
                : '在今日待办或读信页点「我来跟」，发信后也会自动认领。'}
            </small>
            {followFilter !== 'all' && (
              <button type="button" className="btn-ghost sm" onClick={() => setFollowFilter('all')}>查看全部</button>
            )}
          </div>
        )}
        {visible.map((d) => {
          const due = !!(d.nextFollowAt && d.nextFollowAt <= (followCounts.at || Date.now()));
          const canEdit = d.mine || d.canRelease;
          return (
            <div
              key={d.id}
              className={'deal-row' + (d.mine ? ' mine' : '') + (due ? ' follow-due' : '')}
            >
              <div className="deal-row-main">
                <button type="button" className="deal-row-title" onClick={() => openDeal(d)} title={d.lastMessageId ? '打开线索邮件' : '查看客户'}>
                  <b>{d.scopeLabel}</b>
                  {d.lastMessageId ? <Mail size={12} className="deal-mail-ico" /> : null}
                </button>
                <span className="deal-row-meta">
                  {d.mine ? '我跟' : d.owner?.name || '同事'}
                  {d.lastAddress ? ` · ${d.lastAddress}` : ''}
                  {' · '}
                  {formatShortDateTime(d.stageUpdatedAt || d.claimedAt)}
                </span>
                {d.note ? <span className="deal-row-note">{d.note}</span> : null}
                {d.nextFollowAt ? (
                  <span className={'deal-row-follow' + (due ? ' due' : '')}>
                    跟进 {formatShortDateTime(d.nextFollowAt)}
                    {due ? ' · 已到期' : ''}
                  </span>
                ) : null}
                {canEdit && due && (
                  <div className="deal-follow-actions" onClick={(e) => e.stopPropagation()}>
                    {followPresets().map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className="chip-btn"
                        disabled={busyId === d.id}
                        onClick={() => setFollowAt(d, p.at)}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="chip-btn mute"
                      disabled={busyId === d.id}
                      onClick={() => setFollowAt(d, null)}
                    >
                      清除
                    </button>
                    {d.lastAddress && onComposeOutreach && (
                      <button
                        type="button"
                        className="chip-btn primary"
                        disabled={busyId === d.id}
                        onClick={() => writeFollow(d)}
                      >
                        <Send size={11} /> 写跟进
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="deal-row-stage" title={stageChecklist(d.stage) || d.stageLabel}>
                <span className="deal-stage-dot" style={{ background: d.stageColor }} />
                <span className="deal-row-stage-text">
                  <b>{d.stageLabel}</b>
                  {d.mine && stageChecklist(d.stage) ? <small>{stageChecklist(d.stage)}</small> : null}
                </span>
              </div>
              {canEdit && (
                <select
                  className="deal-stage-select"
                  value={d.stage}
                  disabled={busyId === d.id}
                  onChange={(e) => setDealStage(d, e.target.value)}
                  aria-label="更改阶段"
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn-ghost sm"
                onClick={() => openDeal(d)}
                title={d.lastMessageId ? '打开线索' : '查看客户'}
              >
                {d.lastMessageId ? '打开' : '查看'}
              </button>
              {busyId === d.id && <Loader2 size={14} className="spin" />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
