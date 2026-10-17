import React, { useMemo, useState } from 'react';
import { Menu, RefreshCw, Hourglass, Hand, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { Row } from './MailList.jsx';
import ClaimFilter, { filterByClaim, loadClaimFilter, saveClaimFilter } from './ClaimFilter.jsx';

const TABS = [
  { key: 'mine', label: '等我' },
  { key: 'them', label: '等对方' },
  { key: 'overdue', label: '已超时' },
];

/** 统一 Waiting：复用 Focus 数据 + Row；支持单封/批量认领 */
export default function Waiting({
  data, messages, loading, error, selectedId, onSelect, onAction, mailboxMap, onRefresh, refreshing, onFollowUp, onMenu, tab, setTab, notify, checked, setChecked,
}) {
  const reply = messages.filter((m) => m._section === 'reply');
  const follow = messages.filter((m) => m._section === 'follow');
  const overdue = reply.filter((m) => m.priority?.overdue);
  const [claimFilter, setClaimFilter] = useState(() => loadClaimFilter('zm_waiting_claim'));
  const [claimBusy, setClaimBusy] = useState(false);

  const setClaim = (v) => {
    setClaimFilter(v);
    saveClaimFilter(v, 'zm_waiting_claim');
  };

  const filteredReply = useMemo(() => filterByClaim(reply, claimFilter), [reply, claimFilter]);
  const filteredFollow = useMemo(() => filterByClaim(follow, claimFilter), [follow, claimFilter]);
  const filteredOverdue = useMemo(() => filterByClaim(overdue, claimFilter), [overdue, claimFilter]);

  const list = useMemo(() => {
    if (tab === 'overdue') return filteredOverdue.map((m) => ({ ...m, _wait: 'overdue' }));
    if (tab === 'them') return filteredFollow.map((m) => ({ ...m, _wait: 'them' }));
    return filteredReply.map((m) => ({ ...m, _wait: 'mine' }));
  }, [tab, filteredOverdue, filteredFollow, filteredReply]);

  const counts = {
    mine: filteredReply.length,
    them: filteredFollow.length,
    overdue: filteredOverdue.length,
  };
  const sourceForClaim = tab === 'them' ? follow : tab === 'overdue' ? overdue : reply;
  const unclaimedN = sourceForClaim.filter((m) => !m.deal).length;
  const mineN = sourceForClaim.filter((m) => m.deal?.mine).length;
  const multi = Object.keys(mailboxMap).length > 1;
  const emptyText =
    claimFilter !== 'all' && (tab === 'them' ? follow.length : tab === 'overdue' ? overdue.length : reply.length) > 0
      ? '当前认领筛选下没有邮件'
      : tab === 'them'
        ? '没有正在等待客户回复的线索'
        : tab === 'overdue'
          ? '很好，没有超时邮件'
          : '没有等待你回复的邮件';

  async function claimOne(m) {
    const address = m.from?.address;
    if (!address || claimBusy) return;
    setClaimBusy(true);
    try {
      const d = await api('/deals/claim', { method: 'POST', body: { address, threadId: m.threadId, messageId: m.id } });
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
          ? `已认领 ${r.claimedCount} 个客户，${r.skippedCount} 个跳过`
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

  const showClaimBatch = tab === 'mine' || tab === 'overdue';

  return (
    <section className="list-pane waiting-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>等待</h2>
            <small>等我回复 · 等对方回复</small>
          </div>
          {showClaimBatch && checked?.size > 0 && (
            <button type="button" className="icon-btn" title="批量认领未跟客户" disabled={claimBusy} onClick={claimSelected}>
              {claimBusy ? <Loader2 size={15} className="spin" /> : <Hand size={15} />}
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onRefresh} title="同步" aria-label="同步">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
        <div className="tabs waiting-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'active' : ''}
              onClick={() => setTab(t.key)}
              aria-label={`${t.label} ${counts[t.key]}`}
            >
              {t.label} {counts[t.key] || ''}
            </button>
          ))}
        </div>
        <ClaimFilter value={claimFilter} onChange={setClaim} unclaimedN={unclaimedN} mineN={mineN} />
        <p className="waiting-hint">默认「跟进中」= 未认领+我跟 · 可单封/批量认领 · 等对方勿催同事客户</p>
      </header>
      <div className="list-body">
        {error && <div className="list-error">{error}</div>}
        {loading && !list.length && (
          <div className="skeletons">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton-row"><div className="sk-avatar" /><div className="sk-lines"><div /><div /><div /></div></div>
            ))}
          </div>
        )}
        {!loading && !list.length && !error && (
          <div className="empty">
            <Hourglass size={42} strokeWidth={1.2} />
            <p>{emptyText}</p>
            {claimFilter !== 'all' && (
              <button type="button" className="btn-ghost sm" onClick={() => setClaim('all')}>查看全部</button>
            )}
          </div>
        )}
        {list.map((m) => (
          <Row
            key={m.id}
            m={m}
            mb={mailboxMap[m.mailboxId]}
            showMailbox={multi}
            selected={selectedId === m.id}
            checked={checked?.has?.(m.id) || false}
            onSelect={onSelect}
            onToggleCheck={(id) => {
              if (!setChecked) return onSelect(m);
              setChecked((prev) => {
                const next = new Set(prev || []);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              });
            }}
            onAction={onAction}
            variant={m._section === 'follow' ? 'follow' : m._section === 'reply' ? 'reply' : 'mail'}
            onFollowUp={onFollowUp}
            onClaim={m._section === 'reply' ? claimOne : undefined}
            claimBusy={claimBusy}
          />
        ))}
      </div>
    </section>
  );
}
