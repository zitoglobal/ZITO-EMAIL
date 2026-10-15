import React, { useMemo, useState } from 'react';
import { Menu, RefreshCw, Hourglass } from 'lucide-react';
import { Row } from './MailList.jsx';

const TABS = [
  { key: 'mine', label: '等我' },
  { key: 'them', label: '等对方' },
  { key: 'overdue', label: '已超时' },
];

/** 统一 Waiting：复用 Focus 数据 + Row */
export default function Waiting({
  data, messages, loading, error, selectedId, onSelect, onAction, mailboxMap, onRefresh, refreshing, onFollowUp, onMenu, tab, setTab,
}) {
  const reply = messages.filter((m) => m._section === 'reply');
  const follow = messages.filter((m) => m._section === 'follow');
  const overdue = reply.filter((m) => m.priority?.overdue);
  const mine = reply;
  const them = follow;

  const list = useMemo(() => {
    if (tab === 'overdue') return overdue.map((m) => ({ ...m, _wait: 'overdue' }));
    if (tab === 'them') return them.map((m) => ({ ...m, _wait: 'them' }));
    return mine.map((m) => ({ ...m, _wait: 'mine' }));
  }, [tab, overdue, them, mine]);

  const counts = { mine: mine.length, them: them.length, overdue: overdue.length };
  const multi = Object.keys(mailboxMap).length > 1;
  const emptyText = tab === 'them' ? '没有正在等待客户回复的线索' : tab === 'overdue' ? '很好，没有超时邮件' : '没有等待你回复的邮件';

  return (
    <section className="list-pane waiting-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>等待</h2>
            <small>等我回复 · 等对方回复</small>
          </div>
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
        <p className="waiting-hint">等我 = 需你回；等对方 = 你已回待回音；已超时 = 超过回复时限</p>
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
          </div>
        )}
        {list.map((m) => (
          <Row
            key={m.id}
            m={m}
            mb={mailboxMap[m.mailboxId]}
            showMailbox={multi}
            selected={selectedId === m.id}
            checked={false}
            onSelect={onSelect}
            onToggleCheck={() => onSelect(m)}
            onAction={onAction}
            variant={m._section === 'follow' ? 'follow' : m._section === 'reply' ? 'reply' : 'mail'}
            onFollowUp={onFollowUp}
          />
        ))}
      </div>
    </section>
  );
}
