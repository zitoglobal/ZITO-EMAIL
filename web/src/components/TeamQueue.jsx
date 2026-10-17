import React, { useCallback, useEffect, useState } from 'react';
import { Menu, RefreshCw, Users, Hand, Loader2, Mail, Crown, AlertTriangle, UserPlus } from 'lucide-react';
import { api } from '../api.js';
import { displayName, relativeTime, waitText } from '../utils.js';

/**
 * 团队公海：跨成员未认领客户来信（认领/指派；仅自己邮箱可打开原文）
 */
export default function TeamQueue({ onMenu, notify, onOpenMessage, onGoToday, isAdmin }) {
  const [data, setData] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('all'); // all | overdue | vip | mine | others
  const [assignFor, setAssignFor] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const q = await api('/team/queue');
      setData(q);
      if (q.canAssign || isAdmin) {
        const m = await api('/team/members').catch(() => ({ members: [] }));
        setMembers(m.members || []);
      }
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
    const onDeal = () => load(true);
    window.addEventListener('zm-deal', onDeal);
    return () => window.removeEventListener('zm-deal', onDeal);
  }, [load]);

  const items = (data?.items || []).filter((it) => {
    if (filter === 'mine') return it.mine;
    if (filter === 'others') return !it.mine;
    if (filter === 'overdue') return it.overdue;
    if (filter === 'vip') return it.vip;
    return true;
  });

  function afterClaim(label, { assigned } = {}) {
    notify?.(
      assigned ? `已指派 ${label}` : `已认领 ${label}`,
      'success',
      onGoToday
        ? {
            label: '去今日待办',
            fn: () => onGoToday(),
          }
        : null,
      10_000
    );
  }

  async function claim(it) {
    const addr = it.from?.address;
    if (!addr) return;
    setBusy(it.scopeKey);
    try {
      await api('/deals/claim', { method: 'POST', body: { address: addr, threadId: it.threadId } });
      afterClaim(it.scopeLabel);
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.scopeKey !== it.scopeKey) } : d));
    } catch (e) {
      if (e.status === 409) notify?.(e.message || '同事已认领', 'error');
      else notify?.(e.message, 'error');
      load(true);
    } finally {
      setBusy('');
    }
  }

  async function assignTo(it, userId) {
    const addr = it.from?.address;
    if (!addr || !userId) return;
    setBusy(it.scopeKey);
    setAssignFor(null);
    try {
      await api('/deals/assign', {
        method: 'POST',
        body: { address: addr, threadId: it.threadId, toUserId: Number(userId) },
      });
      const who = members.find((m) => m.id === Number(userId));
      afterClaim(`${it.scopeLabel} → ${who?.name || '成员'}`, { assigned: true });
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.scopeKey !== it.scopeKey) } : d));
    } catch (e) {
      notify?.(e.message, 'error');
      load(true);
    } finally {
      setBusy('');
    }
  }

  const canAssign = !!(data?.canAssign || isAdmin);

  return (
    <section className="list-pane team-queue-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>团队公海</h2>
            <small>未认领优先跟 · VIP / 超时靠前</small>
          </div>
          <button type="button" className="icon-btn" onClick={() => load(true)} title="刷新" aria-label="刷新">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
        <div className="segmented claim-filter tq-filters">
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            全部 {data?.stats?.total ?? ''}
          </button>
          <button type="button" className={filter === 'overdue' ? 'on' : ''} onClick={() => setFilter('overdue')}>
            超时 {data?.stats?.overdue ?? ''}
          </button>
          <button type="button" className={filter === 'vip' ? 'on' : ''} onClick={() => setFilter('vip')}>
            VIP {data?.stats?.vip ?? ''}
          </button>
          <button type="button" className={filter === 'mine' ? 'on' : ''} onClick={() => setFilter('mine')}>
            我的箱
          </button>
          <button type="button" className={filter === 'others' ? 'on' : ''} onClick={() => setFilter('others')}>
            同事箱
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
            <p>公海暂无符合条件的来信</p>
            <small className="muted">新询盘进入各成员收件箱且无人认领时会出现在这里</small>
          </div>
        )}
        <ul className="team-queue-list">
          {items.map((it) => (
            <li
              key={it.scopeKey}
              className={
                'team-queue-row' +
                (it.mine ? ' mine' : '') +
                (it.overdue ? ' overdue' : '') +
                (it.vip ? ' vip' : '')
              }
            >
              <div className="tq-main">
                <div className="tq-from">
                  <b>{displayName(it.from)}</b>
                  <span className="tq-scope">{it.scopeLabel}</span>
                  {it.vip && (
                    <span className="tq-badge vip"><Crown size={10} /> VIP</span>
                  )}
                  {it.overdue && (
                    <span className="tq-badge overdue"><AlertTriangle size={10} /> 超时</span>
                  )}
                  {it.waitingHours >= 1 && (
                    <span className={'tq-wait' + (it.overdue ? ' overdue' : '')}>
                      已等 {waitText(it.waitingHours)}
                      {it.slaHours != null ? ` / SLA ${it.slaHours}h` : ''}
                    </span>
                  )}
                </div>
                <div className="tq-subj">{it.subject || '(无主题)'}</div>
                <div className="tq-meta">
                  <span>{it.owner?.name} · {it.owner?.mailbox}</span>
                  <span>{relativeTime(it.date)}</span>
                </div>
                {assignFor === it.scopeKey && canAssign && (
                  <div className="tq-assign">
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) assignTo(it, e.target.value);
                      }}
                      aria-label="指派给"
                    >
                      <option value="" disabled>选择同事…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}{m.role === 'admin' ? '（管理员）' : ''}</option>
                      ))}
                    </select>
                    <button type="button" className="btn-ghost xs" onClick={() => setAssignFor(null)}>取消</button>
                  </div>
                )}
              </div>
              <div className="tq-actions">
                {it.canOpen && (
                  <button type="button" className="btn-ghost sm" onClick={() => onOpenMessage?.(it.id)} title="打开原文">
                    <Mail size={13} /> 打开
                  </button>
                )}
                {canAssign && (
                  <button
                    type="button"
                    className="btn-ghost sm"
                    disabled={busy === it.scopeKey}
                    onClick={() => setAssignFor(assignFor === it.scopeKey ? null : it.scopeKey)}
                  >
                    <UserPlus size={13} /> 指派
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
