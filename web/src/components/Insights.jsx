import React, { useCallback, useEffect, useState } from 'react';
import { Menu, RefreshCw, BarChart3, Crown, AlertTriangle, Activity, Wifi } from 'lucide-react';
import { api, qs } from '../api.js';
import { dayStart, relativeTime } from '../utils.js';

export default function Insights({ onMenu, isAdmin }) {
  const [data, setData] = useState(null);
  const [ops, setOps] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [ins, opsRes] = await Promise.all([
        api('/insights' + qs({ dayStart: dayStart() })),
        isAdmin ? api('/admin/ops').catch(() => null) : Promise.resolve(null),
      ]);
      setData(ins);
      setOps(opsRes);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const f = data?.focus || {};
  const tiers = data?.overdueByTier || {};
  const maxClaim = Math.max(1, ...(data?.claimsByUser || []).map((c) => c.count));
  const maxStage = Math.max(1, ...(data?.stages || []).map((s) => s.count));
  const mb = ops?.mailboxes || {};

  return (
    <section className="list-pane insights-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>销售洞察</h2>
            <small>团队 SLA · 认领 · 管线{isAdmin ? ' · 运维' : ''}</small>
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
            {ops && (
              <>
                <h3 className="insights-h"><Activity size={14} /> 系统状态</h3>
                <div className="insights-grid ops">
                  <div className="insight-card">
                    <span><Wifi size={12} /> 在线</span><b>{ops.onlineUsers}</b>
                  </div>
                  <div className={'insight-card' + (mb.error ? ' danger' : '')}>
                    <span>同步失败</span><b>{mb.error || 0}</b>
                  </div>
                  <div className="insight-card">
                    <span>邮箱总数</span><b>{mb.total || 0}</b>
                  </div>
                  <div className="insight-card">
                    <span>今日认领</span><b>{ops.claimsToday || 0}</b>
                  </div>
                </div>
                <div className="ops-flags">
                  <span className={ops.aiConfigured ? 'ok' : 'warn'}>AI {ops.aiConfigured ? '已配' : '未配'}</span>
                  <span className={ops.mailSecretConfigured ? 'ok' : 'warn'}>密钥 {ops.mailSecretConfigured ? '正常' : '弱'}</span>
                  <span className={ops.oauthProviders?.gmail ? 'ok' : 'mute'}>Gmail OAuth {ops.oauthProviders?.gmail ? '开' : '关'}</span>
                  <span className={ops.oauthProviders?.microsoft ? 'ok' : 'mute'}>M365 OAuth {ops.oauthProviders?.microsoft ? '开' : '关'}</span>
                  {ops.lastBackupAt && <span className="mute">备份 {relativeTime(ops.lastBackupAt)}</span>}
                </div>
                {(ops.errorMailboxes || []).length > 0 && (
                  <ul className="ops-errors">
                    {ops.errorMailboxes.slice(0, 6).map((e) => (
                      <li key={e.id}>
                        <b>{e.email}</b>
                        <small>{e.user} · {e.error || '同步失败'}</small>
                      </li>
                    ))}
                  </ul>
                )}
                {(ops.focusSample || []).length > 0 && (
                  <>
                    <h3 className="insights-h">Focus 抽样（我的）</h3>
                    <ul className="ops-sample">
                      {ops.focusSample.map((s) => (
                        <li key={s.section + s.id}>
                          <em>{s.section === 'reply' ? '待回' : '等待'}</em>
                          <span className="ops-subj">{s.subject || '(无主题)'}</span>
                          <small>{s.why || '—'}</small>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}

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
