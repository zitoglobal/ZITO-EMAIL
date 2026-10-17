import React, { useCallback, useEffect, useState } from 'react';
import { Menu, RefreshCw, Users, Hand, Loader2, Mail } from 'lucide-react';
import { api } from '../api.js';
import { displayName, relativeTime, waitText } from '../utils.js';

/**
 * 团队公海：跨成员未认领客户来信（认领后进「我的客户」；仅自己邮箱可打开原文）
 */
export default function TeamQueue({ onMenu, notify, onOpenMessage }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('all'); // all | mine | others

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      setData(await api('/team/queue'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = (data?.items || []).filter((it) => {
    if (filter === 'mine') return it.mine;
    if (filter === 'others') return !it.mine;
    return true;
  });

  async function claim(it) {
    const addr = it.from?.address;
    if (!addr) return;
    setBusy(it.scopeKey);
    try {
      await api('/deals/claim', { method: 'POST', body: { address: addr, threadId: it.threadId } });
      notify?.(`已认领 ${it.scopeLabel}`, 'success');
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.scopeKey !== it.scopeKey) } : d));
    } catch (e) {
      if (e.status === 409) notify?.(e.message || '同事已认领', 'error');
      else notify?.(e.message, 'error');
      load(true);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="list-pane team-queue-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>团队公海</h2>
            <small>未认领客户来信 · 先认领再跟</small>
          </div>
          <button type="button" className="icon-btn" onClick={() => load(true)} title="刷新" aria-label="刷新">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
        <div className="segmented claim-filter">
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            全部 {data?.stats?.total ?? ''}
          </button>
          <button type="button" className={filter === 'mine' ? 'on' : ''} onClick={() => setFilter('mine')}>
            我的箱 {data?.stats?.mine ?? ''}
          </button>
          <button type="button" className={filter === 'others' ? 'on' : ''} onClick={() => setFilter('others')}>
            同事箱 {data?.stats?.others ?? ''}
          </button>
        </div>
      </header>
      <div className="list-body">
        {error && <div className="list-error">{error}</div>}
        {loading && !data && (
          <div className="skeletons">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton-row"><div className="sk-lines"><div /><div /></div></div>
            ))}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="empty focus-empty">
            <Users size={28} strokeWidth={1.5} />
            <p>公海暂无未认领客户来信</p>
            <small className="muted">新询盘进入各成员收件箱且无人认领时会出现在这里</small>
          </div>
        )}
        <ul className="team-queue-list">
          {items.map((it) => (
            <li key={it.scopeKey} className={'team-queue-row' + (it.mine ? ' mine' : '')}>
              <div className="tq-main">
                <div className="tq-from">
                  <b>{displayName(it.from)}</b>
                  <span className="tq-scope">{it.scopeLabel}</span>
                  {it.waitingHours >= 1 && (
                    <span className={'tq-wait' + (it.waitingHours >= 24 ? ' overdue' : '')}>
                      已等 {waitText(it.waitingHours)}
                    </span>
                  )}
                </div>
                <div className="tq-subj">{it.subject || '(无主题)'}</div>
                <div className="tq-meta">
                  <span>{it.owner?.name} · {it.owner?.mailbox}</span>
                  <span>{relativeTime(it.date)}</span>
                </div>
              </div>
              <div className="tq-actions">
                {it.canOpen && (
                  <button type="button" className="btn-ghost sm" onClick={() => onOpenMessage?.(it.id)} title="打开原文">
                    <Mail size={13} /> 打开
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary sm"
                  disabled={busy === it.scopeKey}
                  onClick={() => claim(it)}
                >
                  {busy === it.scopeKey ? <Loader2 size={13} className="spin" /> : <Hand size={13} />}
                  我来跟
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
