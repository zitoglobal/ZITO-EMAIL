import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Menu, RefreshCw, Briefcase, Loader2 } from 'lucide-react';
import { api, qs } from '../api.js';
import { formatShortDateTime } from '../utils.js';

/**
 * 「我的客户」轻列表 — 按业务阶段扫管线（邮箱内 deals，非独立 CRM）
 */
export default function Deals({ onMenu, notify, onOpenDeal }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [deals, setDeals] = useState([]);
  const [stages, setStages] = useState([]);
  const [owner, setOwner] = useState('mine');
  const [stage, setStage] = useState('all');
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

  const counts = useMemo(() => {
    const map = { all: deals.length };
    for (const s of stages) map[s.id] = 0;
    for (const d of deals) map[d.stage] = (map[d.stage] || 0) + 1;
    return map;
  }, [deals, stages]);

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

  return (
    <section className="list-pane deals-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>我的客户</h2>
            <small>认领管线 · 按阶段扫一眼</small>
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
        {!loading && !error && !deals.length && (
          <div className="empty">
            <Briefcase size={42} strokeWidth={1.2} />
            <p>还没有认领客户</p>
            <small>在今日待办或读信页点「我来跟」，发信后也会自动认领。</small>
          </div>
        )}
        {deals.map((d) => (
          <div key={d.id} className={'deal-row' + (d.mine ? ' mine' : '')}>
            <div className="deal-row-main">
              <b>{d.scopeLabel}</b>
              <span className="deal-row-meta">
                {d.mine ? '我跟' : d.owner?.name || '同事'}
                {d.lastAddress ? ` · ${d.lastAddress}` : ''}
                {' · '}
                {formatShortDateTime(d.stageUpdatedAt || d.claimedAt)}
              </span>
              {d.note ? <span className="deal-row-note">{d.note}</span> : null}
              {d.nextFollowAt ? (
                <span className={'deal-row-follow' + (d.nextFollowAt <= Date.now() ? ' due' : '')}>
                  跟进 {formatShortDateTime(d.nextFollowAt)}
                </span>
              ) : null}
            </div>
            <div className="deal-row-stage">
              <span className="deal-stage-dot" style={{ background: d.stageColor }} />
              {d.stageLabel}
            </div>
            {(d.mine || d.canRelease) && (
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
            {d.lastAddress && onOpenDeal && (
              <button
                type="button"
                className="btn-ghost sm"
                onClick={() => onOpenDeal(d)}
              >
                查看
              </button>
            )}
            {busyId === d.id && <Loader2 size={14} className="spin" />}
          </div>
        ))}
      </div>
    </section>
  );
}
