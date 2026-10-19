import React, { useCallback, useEffect, useState } from 'react';
import { Menu, RefreshCw, BarChart3, Crown, AlertTriangle, Activity, Wifi } from 'lucide-react';
import { api, qs } from '../api.js';
import { dayStart, relativeTime } from '../utils.js';

export default function Insights({ onMenu, isAdmin, onGo, onOpenMessage, onOpenSettings }) {
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

  useEffect(() => {
    const onBump = () => load(true);
    window.addEventListener('zm-deal', onBump);
    window.addEventListener('zm-collab', onBump);
    return () => {
      window.removeEventListener('zm-deal', onBump);
      window.removeEventListener('zm-collab', onBump);
    };
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
                  <span className={ops.oauthProviders?.ready ? 'ok' : 'warn'}>OAuth {ops.oauthProviders?.ready ? '就绪' : '未就绪'}</span>
                  <span className={ops.oauthProviders?.gmail ? 'ok' : 'mute'}>Gmail {ops.oauthProviders?.gmail ? '开' : '关'}</span>
                  <span className={ops.oauthProviders?.microsoft ? 'ok' : 'mute'}>M365 {ops.oauthProviders?.microsoft ? '开' : '关'}</span>
                  {ops.lastBackupAt && <span className="mute">备份 {relativeTime(ops.lastBackupAt)}</span>}
                </div>
                {(ops.errorMailboxes || []).length > 0 && (
                  <ul className="ops-errors">
                    {ops.errorMailboxes.slice(0, 6).map((e) => (
                      <li
                        key={e.id}
                        className={onOpenSettings ? 'clickable-row' : ''}
                        onClick={() => onOpenSettings?.('mailboxes')}
                        title="去设置修复邮箱"
                      >
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
                        <li
                          key={s.section + s.id}
                          className={onOpenMessage ? 'clickable-row' : ''}
                          onClick={() => onOpenMessage?.(s.id)}
                          title="打开该邮件"
                        >
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
              <button type="button" className="insight-card clickable" onClick={() => onGo?.('waiting', 'mine')} title="打开等待 · 等我">
                <span>待回复</span><b>{f.needReply}</b>
              </button>
              <button type="button" className={'insight-card clickable' + (f.overdue ? ' danger' : '')} onClick={() => onGo?.('waiting', 'overdue')} title="打开等待 · 已超时">
                <span>已超时</span><b>{f.overdue}</b>
              </button>
              <button type="button" className="insight-card clickable" onClick={() => onGo?.('waiting', 'them')} title="打开等待 · 等对方">
                <span>待跟进</span><b>{f.followups}</b>
              </button>
              <button type="button" className="insight-card clickable" onClick={() => onGo?.('today')} title="打开今日待办">
                <span>今日已处理</span><b>{f.handledToday}</b>
              </button>
            </div>

            <h3 className="insights-h"><AlertTriangle size={14} /> 超时分层</h3>
            <div className="insights-tiers">
              <button type="button" className="tier-pill vip clickable" onClick={() => onGo?.('waiting', 'overdue')}>
                <Crown size={12} /> VIP {tiers.vip || 0}
              </button>
              <button type="button" className="tier-pill clickable" onClick={() => onGo?.('waiting', 'overdue')}>
                老客户 {tiers.customer || 0}
              </button>
              <button type="button" className="tier-pill clickable" onClick={() => onGo?.('waiting', 'overdue')}>
                新询盘 {tiers.new || 0}
              </button>
              {(tiers.other || 0) > 0 && (
                <button type="button" className="tier-pill clickable" onClick={() => onGo?.('waiting', 'overdue')}>
                  其他 {tiers.other}
                </button>
              )}
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

            <h3 className="insights-h">
              <button type="button" className="linkish" onClick={() => onGo?.('deals')}>成衣漏斗</button>
              {data.funnel?.wonRate != null && (
                <small className="muted" style={{ marginLeft: 8 }}>近管线成交率 {data.funnel.wonRate}%</small>
              )}
            </h3>
            <ul className="insights-bars funnel">
              {(data.funnel?.stages || data.stages || []).map((s) => {
                const maxF = Math.max(1, ...(data.funnel?.stages || data.stages || []).map((x) => x.count));
                return (
                  <li key={s.id} className="clickable-row" onClick={() => onGo?.('deals', { stage: s.id })}>
                    <span className="bar-label" style={{ color: s.color }}>{s.label}</span>
                    <span className="bar-track"><i style={{ width: `${(s.count / maxF) * 100}%`, background: s.color }} /></span>
                    <span className="bar-n">{s.count}</span>
                  </li>
                );
              })}
            </ul>
            {data.funnel?.transitions30d && (
              <div className="insights-funnel-trans muted">
                近 30 天进入：报价 {data.funnel.transitions30d.toQuote || 0}
                · 样品 {data.funnel.transitions30d.toSample || 0}
                · 大货 {data.funnel.transitions30d.toBulk || 0}
                · 成交 {data.funnel.transitions30d.toWon || 0}
                · 丢单 {data.funnel.transitions30d.toLost || 0}
              </div>
            )}
            {data.funnel?.cohort30d && (
              <div className="insights-funnel-trans muted" title="按阶段变更事件粗算，非严格归因 cohort">
                近 30 日转化：询盘→报价 {data.funnel.cohort30d.inquiryToQuote || 0}
                {data.funnel.cohort30d.inquiryToQuoteRate != null ? `（${data.funnel.cohort30d.inquiryToQuoteRate}%）` : ''}
                · 报价→样品 {data.funnel.cohort30d.quoteToSample || 0}
                {data.funnel.cohort30d.quoteToSampleRate != null ? `（${data.funnel.cohort30d.quoteToSampleRate}%）` : ''}
                · 样品→大货 {data.funnel.cohort30d.sampleToBulk || 0}
                {data.funnel.cohort30d.sampleToBulkRate != null ? `（${data.funnel.cohort30d.sampleToBulkRate}%）` : ''}
              </div>
            )}

            <h3 className="insights-h">我的跟进日</h3>
            <div className="insights-follow">
              <button type="button" className="linkish" onClick={() => onGo?.('deals', { followFilter: 'due' })}>
                已到期 <b>{data.follow?.due || 0}</b>
              </button>
              <span className="dot">·</span>
              <button type="button" className="linkish" onClick={() => onGo?.('deals', { followFilter: 'planned' })}>
                7 日内 <b>{data.follow?.upcoming7d || 0}</b>
              </button>
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
