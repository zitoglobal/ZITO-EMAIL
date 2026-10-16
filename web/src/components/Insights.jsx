import React, { useCallback, useEffect, useState } from 'react';
import { Menu, RefreshCw, BarChart3, Crown, AlertTriangle } from 'lucide-react';
import { api, qs } from '../api.js';
import { dayStart } from '../utils.js';

export default function Insights({ onMenu }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      setData(await api('/insights' + qs({ dayStart: dayStart() })));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const f = data?.focus || {};
  const tiers = data?.overdueByTier || {};
  const maxClaim = Math.max(1, ...(data?.claimsByUser || []).map((c) => c.count));
  const maxStage = Math.max(1, ...(data?.stages || []).map((s) => s.count));

  return (
    <section className="list-pane insights-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>销售洞察</h2>
            <small>团队 SLA · 认领 · 管线</small>
          </div>
          <button type="button" className="icon-btn" onClick={() => load(true)} title="刷新" aria-label="刷新">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>
      <div className="list-body insights-body">
        {error && <div className="list-error">{error}</div>}
        {loading && !data && (
          <div className="skeletons">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton-row"><div className="sk-lines"><div /><div /></div></div>
            ))}
          </div>
        )}
        {data && (
          <>
            <div className="insights-grid">
              <div className="insight-card">
                <span>待回复</span><b>{f.needReply}</b>
              </div>
              <div className={'insight-card' + (f.overdue ? ' danger' : '')}>
                <span>已超时</span><b>{f.overdue}</b>
              </div>
              <div className="insight-card">
                <span>待跟进</span><b>{f.followups}</b>
              </div>
              <div className="insight-card">
                <span>今日已处理</span><b>{f.handledToday}</b>
              </div>
            </div>

            <h3 className="insights-h"><AlertTriangle size={14} /> 超时分层</h3>
            <div className="insights-tiers">
              <span className="tier-pill vip"><Crown size={12} /> VIP {tiers.vip || 0}</span>
              <span className="tier-pill">老客户 {tiers.customer || 0}</span>
              <span className="tier-pill">新询盘 {tiers.new || 0}</span>
              {(tiers.other || 0) > 0 && <span className="tier-pill">其他 {tiers.other}</span>}
              {data.overdueOldestHours > 0 && (
                <small className="muted">最早已等 {data.overdueOldestHours}h</small>
              )}
            </div>

            <h3 className="insights-h"><BarChart3 size={14} /> 认领分布</h3>
            <ul className="insights-bars">
              {(data.claimsByUser || []).length === 0 && <li className="muted">尚无认领记录</li>}
              {(data.claimsByUser || []).map((c) => (
                <li key={c.userId}>
                  <span className="bar-label">{c.name}{c.mine ? '（我）' : ''}</span>
                  <span className="bar-track"><i style={{ width: `${(c.count / maxClaim) * 100}%` }} /></span>
                  <span className="bar-n">{c.count}</span>
                </li>
              ))}
            </ul>

            <h3 className="insights-h">阶段管线</h3>
            <ul className="insights-bars">
              {(data.stages || []).map((s) => (
                <li key={s.id}>
                  <span className="bar-label" style={{ color: s.color }}>{s.label}</span>
                  <span className="bar-track"><i style={{ width: `${(s.count / maxStage) * 100}%`, background: s.color }} /></span>
                  <span className="bar-n">{s.count}</span>
                </li>
              ))}
            </ul>

            <h3 className="insights-h">我的跟进日</h3>
            <div className="insights-follow">
              <span>已到期 <b>{data.follow?.due || 0}</b></span>
              <span className="dot">·</span>
              <span>7 日内 <b>{data.follow?.upcoming7d || 0}</b></span>
            </div>

            {(data.stageAge || []).length > 0 && (
              <>
                <h3 className="insights-h">我跟客户 · 阶段停留（天）</h3>
                <ul className="insights-age">
                  {data.stageAge.map((s) => (
                    <li key={s.stage}>{s.label}：均 {s.avgDays} 天（{s.count}）</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
