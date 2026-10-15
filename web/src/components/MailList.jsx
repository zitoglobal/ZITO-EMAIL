import React, { useEffect, useRef, useState } from 'react';
import {
  Search, RefreshCw, Star, Paperclip, MailOpen, Mail, Trash2, Archive, FolderInput, X, Menu, CornerUpLeft, Loader2, Inbox, Clock, Pin,
  ServerCrash, ShieldAlert, CheckCheck, Crown, Flame, Hourglass, Sparkles, CheckCircle2, Reply, BellOff, Send, Tag,
} from 'lucide-react';
import LabelMenu from './LabelMenu.jsx';
import {
  CATEGORIES, SIGNALS, avatarColor, displayName, folderLabel, formatListDate, formatShortDateTime, initials, snoozePresets, sortFolders, waitText, whyPriority,
} from '../utils.js';
import TimeMenu from './TimeMenu.jsx';

const QUICK_FILTERS = [
  { token: 'is:unread', label: '未读' },
  { token: 'is:starred', label: '星标' },
  { token: 'has:attachment', label: '有附件' },
  { token: 'is:vip', label: 'VIP' },
];

function remindChip(stage) {
  const s = Number(stage) || 0;
  if (s < 1) return null;
  if (s >= 3) return <span key="rm" className="tag remind-3">终提醒</span>;
  if (s === 2) return <span key="rm" className="tag remind-2">提醒 2</span>;
  return <span key="rm" className="tag remind-1">提醒</span>;
}

function Chips({ m, variant }) {
  const p = m.priority;
  const chips = [];
  if (variant === 'reply' && p) {
    if (p.overdue) chips.push(<span key="aw" className="tag lv-high">超时未回</span>);
    else chips.push(<span key="aw" className="tag await">待回复</span>);
    const rm = remindChip(m.remindStage);
    if (rm && p.overdue) chips.push(rm);
    if (p.tier === 'vip') chips.push(<span key="t" className="tag tier-vip"><Crown size={10} /> VIP</span>);
    else if (p.tier === 'customer') chips.push(<span key="t" className="tag tier-customer">客户</span>);
    else if (p.tier === 'new') chips.push(<span key="t" className="tag tier-new">{p.signals.includes('inquiry') ? '新询盘' : '新联系人'}</span>);
    if (p.level === 'high') chips.push(<span key="lv" className="tag lv-high"><Flame size={10} /> 优先</span>);
    else if (p.level === 'medium') chips.push(<span key="lv" className="tag lv-medium">重要</span>);
    p.signals.filter((s) => SIGNALS[s] && !(p.tier === 'new' && s === 'inquiry')).slice(0, 1).forEach((s) => chips.push(<span key={s} className={'tag sig sig-' + s}>{SIGNALS[s]}</span>));
  } else if (variant === 'follow' && m.follow) {
    chips.push(<span key="wot" className="tag waiting-them">等对方{m.follow.days ? ` · ${m.follow.days}天` : ''}</span>);
    if (m.follow.tier === 'vip') chips.push(<span key="t" className="tag tier-vip"><Crown size={10} /> VIP</span>);
    else if (m.follow.tier === 'customer') chips.push(<span key="t" className="tag tier-customer">客户</span>);
    m.follow.signals.filter((s) => SIGNALS[s]).slice(0, 1).forEach((s) => chips.push(<span key={s} className={'tag sig sig-' + s}>{SIGNALS[s]}</span>));
  } else {
    if (m.awaiting) chips.push(<span key="aw" className={'tag ' + (m.overdue ? 'lv-high' : 'await')}>{m.overdue ? '超时未回' : '待回复'}</span>);
    else if (m.waitingOnThem) {
      const label = m.waitingDays != null && m.waitingDays >= 1 ? `等对方 · ${m.waitingDays}天` : '等对方';
      chips.push(<span key="wot" className="tag waiting-them">{label}</span>);
    }
    const rm = remindChip(m.remindStage);
    if (rm && m.overdue) chips.push(rm);
    if (m.tier === 'vip') chips.push(<span key="t" className="tag tier-vip"><Crown size={10} /> VIP</span>);
    else if (['customer', 'new'].includes(m.tier)) {
      m.signals?.filter((s) => SIGNALS[s]).slice(0, 1).forEach((s) => chips.push(<span key={s} className={'tag sig sig-' + s}>{SIGNALS[s]}</span>));
    }
  }
  const userLabels = Array.isArray(m.labels) ? m.labels : [];
  const labelShown = userLabels.slice(0, 2).map((l) => (
    <span key={'lb' + l.id} className="tag user-label" style={{ '--lc': l.color }}>
      <span className="label-dot xs" style={{ background: l.color }} />
      {l.name}
    </span>
  ));
  const labelMore = userLabels.length > 2 ? (
    <span key="lb+" className="tag user-label more" title={userLabels.slice(2).map((l) => l.name).join('、')}>
      +{userLabels.length - 2}
    </span>
  ) : null;
  const all = [...chips, ...labelShown, ...(labelMore ? [labelMore] : [])];
  const shown = all.slice(0, 4);
  return shown.length ? <div className="row-tags" title={all.length > 4 ? '更多状态已收起' : undefined}>{shown}</div> : null;
}

export function Row({ m, mb, showMailbox, selected, checked, onSelect, onToggleCheck, onAction, isSent, compact, variant = 'mail', onFollowUp }) {
  const [snooze, setSnooze] = useState(false);
  const follow = variant === 'follow';
  const focus = variant !== 'mail';
  const person = follow ? m.follow?.to : isSent ? m.to?.[0] || m.from : m.from;
  const p = m.priority;
  const why = focus ? whyPriority(m, variant) : '';
  return (
    <div
      className={
        'mail-row' + (m.seen || focus ? '' : ' unread') + (selected ? ' selected' : '') + (checked ? ' checked' : '') + (compact && !focus ? ' compact' : '') +
        (focus ? ' focus-row' : '') + (p ? ' lv-' + p.level : '')
      }
      onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? onToggleCheck(m.id, e.shiftKey) : onSelect(m))}
      data-id={m.id}
    >
      {showMailbox && mb && <span className="mb-stripe" style={{ background: mb.color }} title={mb.email} />}
      <div
        className="avatar"
        style={{ background: checked ? 'var(--accent)' : avatarColor(person?.address) }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleCheck(m.id, e.shiftKey);
        }}
        title="选择"
      >
        {checked ? '✓' : initials(person)}
      </div>
      <div className="mail-main">
        <div className="mail-line1">
          <span className="sender">
            {isSent || follow ? '致：' : ''}
            {displayName(person) || '(未知)'}
          </span>
          {(m.tier === 'vip' || p?.tier === 'vip') && variant === 'mail' && <Crown size={12} className="vip-icon" />}
          {m.waitingOnThem && variant === 'mail' && <Hourglass size={12} className="waiting-icon" title="等对方回复" />}
          {m.threadCount > 1 && <span className="thread-count">{m.threadCount}</span>}
          {m.pinned && <Pin size={12} className="pin-icon" />}
          {m.answered && !focus && !m.waitingOnThem && <CornerUpLeft size={12} className="muted-icon" />}
          {m.hasAttachments && <Paperclip size={12} className="muted-icon" />}
          {variant === 'reply' && p ? (
            <span className={'date wait' + (p.overdue ? ' over' : '')} title={`收到于 ${formatShortDateTime(m.date)}${p.slaHours != null ? ` · 时限 ${p.slaHours}h` : ''}`}>
              <Hourglass size={11} /> {waitText(p.waitingHours)}{p.slaHours != null ? <span className="sla-inline">/{p.slaHours}h</span> : null}
            </span>
          ) : follow ? (
            <span className="date wait follow" title={`发出于 ${formatShortDateTime(m.date)}`}><Hourglass size={11} /> {m.follow.days} 天未回</span>
          ) : (
            <span className="date">{m.snoozeUntil ? <><Clock size={11} /> {formatShortDateTime(m.snoozeUntil)}</> : formatListDate(m.date)}</span>
          )}
        </div>
        <div className="mail-line2">
          <span className="subject">{m.subject || '(无主题)'}</span>
        </div>
        {!compact && !(focus && m.aiNote) && (
          <div className="mail-line3">
            <span className="snippet">{m.snippet}</span>
          </div>
        )}
        {focus && m.aiNote && (
          <div className="ai-note"><Sparkles size={11} /> {m.aiNote.note}</div>
        )}
        {(!compact || focus) && !(focus && why) && <Chips m={m} variant={variant} />}
        {why && (
          <div className="why-priority" title="为何出现在今日待办">
            <span className="why-label">为何优先</span>{why}
          </div>
        )}
        {!focus && m.category !== 'people' && m.specialUse === '\\Inbox' && (
          <span className={'cat-tag ' + m.category}>{m.category === 'notification' ? '通知' : '订阅'}</span>
        )}
      </div>

      {focus && (
        <div className="focus-ctas" onClick={(e) => e.stopPropagation()}>
          {variant === 'reply' && (
            <button type="button" className="focus-cta" title="已处理，无需回复 (D)" onClick={() => onAction([m.id], 'done')}>
              <CheckCircle2 size={14} /> 处理
            </button>
          )}
          {follow && (
            <>
              <button type="button" className="focus-cta focus-cta-nudge" title="写跟进催单" onClick={() => onFollowUp?.(m)}>
                <Send size={14} /> 催单
              </button>
              <button type="button" className="focus-cta focus-cta-quiet" title="无需跟进" onClick={() => onAction([m.id], 'nofollow')}>
                <BellOff size={14} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {!focus && variant === 'reply' && (
          <button title="已处理，无需回复" onClick={() => onAction([m.id], 'done')}><CheckCircle2 size={15} /></button>
        )}
        {!focus && follow && (
          <>
            <button title="写跟进邮件" onClick={() => onFollowUp?.(m)}><Reply size={15} /></button>
            <button title="无需跟进" onClick={() => onAction([m.id], 'nofollow')}><BellOff size={15} /></button>
          </>
        )}
        {!follow && <button type="button" title="归档 (E)" aria-label="归档" onClick={() => onAction([m.id], 'archive')}><Archive size={15} /></button>}
        {!follow && <button type="button" title="删除 (#)" aria-label="删除" onClick={() => onAction([m.id], 'trash')}><Trash2 size={15} /></button>}
        {variant === 'mail' && (
          <button type="button" title={m.seen ? '标为未读 (U)' : '标为已读'} aria-label={m.seen ? '标为未读' : '标为已读'} onClick={() => onAction([m.id], m.seen ? 'unread' : 'read')}>
            {m.seen ? <Mail size={15} /> : <MailOpen size={15} />}
          </button>
        )}
        <div className="move-wrap">
          <button type="button" title="稍后提醒 (B)" aria-label="稍后提醒" onClick={() => setSnooze((v) => !v)}><Clock size={15} /></button>
          {snooze && (
            <TimeMenu
              title="稍后提醒"
              presets={snoozePresets()}
              className="right"
              onClose={() => setSnooze(false)}
              onPick={(t) => {
                setSnooze(false);
                onAction([m.id], 'snooze', { until: t });
              }}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        className={'star' + (m.flagged ? ' on' : '')}
        aria-label={m.flagged ? '取消星标' : '星标'}
        onClick={(e) => {
          e.stopPropagation();
          onAction([m.id], m.flagged ? 'unflag' : 'flag');
        }}
      >
        <Star size={14} />
      </button>
    </div>
  );
}

export default function MailList({
  title, subtitle, view, mailboxMap, messages, pinned, loading, loadingMore, hasMore, onLoadMore, selectedId, onSelect,
  checked, setChecked, category, setCategory, showCategories, q, deep, onSearch, onRefresh, refreshing, onAction, moveFolders,
  labels = [], onToggleLabels, onCreateLabel,
  onMenu, error, compact, onMarkAllRead,
}) {
  const [input, setInput] = useState(q);
  const [moveOpen, setMoveOpen] = useState(false);
  const [bulkSnooze, setBulkSnooze] = useState(false);
  const [bulkLabel, setBulkLabel] = useState(false);
  const searchRef = useRef();
  const sentinel = useRef();
  const lastChecked = useRef(null);
  const showMailbox = (view.mailboxId || 'all') === 'all' && Object.keys(mailboxMap).length > 1;
  const isSent = view.box === 'sent' || (view.box === 'folder' && view.special === '\\Sent');
  const all = [...pinned, ...messages];

  useEffect(() => setInput(q), [q]);

  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(el?.tagName) && !el?.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && onLoadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, messages.length]);

  useEffect(() => {
    if (!selectedId) return;
    document.querySelector(`.mail-row[data-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  function toggleCheck(id, range) {
    const next = new Set(checked);
    if (range && lastChecked.current) {
      const ids = all.map((m) => m.id);
      const a = ids.indexOf(lastChecked.current);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
        setChecked(next);
        return;
      }
    }
    next.has(id) ? next.delete(id) : next.add(id);
    lastChecked.current = id;
    setChecked(next);
  }

  function toggleToken(token) {
    const has = input.split(/\s+/).includes(token);
    const nq = has ? input.split(/\s+/).filter((t) => t && t !== token).join(' ') : `${input} ${token}`.trim();
    setInput(nq);
    onSearch(nq, false);
  }

  const allChecked = all.length > 0 && all.every((m) => checked.has(m.id));
  const ids = [...checked];
  const rowProps = (m) => ({
    m,
    mb: mailboxMap[m.mailboxId],
    showMailbox,
    selected: selectedId === m.id,
    checked: checked.has(m.id),
    onSelect,
    onToggleCheck: toggleCheck,
    onAction,
    isSent,
    compact,
  });

  return (
    <section className="list-pane">
      <header className="list-head">
        <div className="list-title-row">
          <button type="button" className="icon-btn mobile-only" onClick={onMenu} aria-label="打开菜单"><Menu size={18} /></button>
          <div className="list-title">
            <h2>{title}</h2>
            {subtitle && <small>{subtitle}</small>}
          </div>
          {onMarkAllRead && (
            <button className="icon-btn" onClick={onMarkAllRead} title="全部标为已读"><CheckCheck size={16} /></button>
          )}
          <button type="button" className="icon-btn" onClick={onRefresh} title="同步" aria-label="同步">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); onSearch(input.trim(), false); }}>
          <Search size={15} />
          <input ref={searchRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="搜索  支持 from: to: subject: has:attachment is:unread" />
          {input && (
            <button type="button" className="clear" onClick={() => { setInput(''); onSearch('', false); }}><X size={14} /></button>
          )}
        </form>
        {q && (
          <div className="search-hint">
            {deep ? '已在邮件服务器上搜索全文（含正文）' : '当前搜索本地缓存的邮件'}
            {!deep && <button className="link-btn" onClick={() => onSearch(q, true)}><ServerCrash size={12} /> 在服务器上搜索全文</button>}
          </div>
        )}

        {showCategories && !q && (
          <div className="tabs">
            {CATEGORIES.map((c) => (
              <button key={c.key} className={category === c.key ? 'active' : ''} onClick={() => setCategory(c.key)}>{c.label}</button>
            ))}
          </div>
        )}

        <div className="filters">
          {checked.size > 0 ? (
            <div className="bulk">
              <input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(all.map((m) => m.id)))} />
              <span>已选 {checked.size}</span>
              <button title="标为已读" onClick={() => onAction(ids, 'read')}><MailOpen size={15} /></button>
              <button title="标为未读" onClick={() => onAction(ids, 'unread')}><Mail size={15} /></button>
              <button title="星标" onClick={() => onAction(ids, 'flag')}><Star size={15} /></button>
              <button title="归档" onClick={() => onAction(ids, 'archive')}><Archive size={15} /></button>
              <button title="删除" onClick={() => onAction(ids, 'trash')}><Trash2 size={15} /></button>
              <button title="垃圾邮件" onClick={() => onAction(ids, 'spam')}><ShieldAlert size={15} /></button>
              <div className="move-wrap">
                <button title="稍后提醒" onClick={() => setBulkSnooze((v) => !v)}><Clock size={15} /></button>
                {bulkSnooze && (
                  <TimeMenu title="稍后提醒" presets={snoozePresets()} onClose={() => setBulkSnooze(false)} onPick={(t) => { setBulkSnooze(false); onAction(ids, 'snooze', { until: t }); }} />
                )}
              </div>
              {moveFolders && (
                <div className="move-wrap">
                  <button title="移动到" onClick={() => setMoveOpen((v) => !v)}><FolderInput size={15} /></button>
                  {moveOpen && (
                    <div className="dropdown" onMouseLeave={() => setMoveOpen(false)}>
                      {sortFolders(moveFolders).map((f) => (
                        <button key={f.path} onClick={() => { setMoveOpen(false); onAction(ids, 'move', { dest: f.path }); }}>{folderLabel(f)}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {onToggleLabels && (
                <div className="move-wrap">
                  <button title="标签" onClick={() => setBulkLabel((v) => !v)}><Tag size={15} /></button>
                  {bulkLabel && (
                    <LabelMenu
                      labels={labels}
                      selectedIds={[]}
                      onClose={() => setBulkLabel(false)}
                      onToggle={(l, on) => {
                        onToggleLabels(ids, on ? { add: [l.id] } : { remove: [l.id] });
                      }}
                      onCreate={onCreateLabel ? async (n) => { await onCreateLabel(n); } : undefined}
                    />
                  )}
                </div>
              )}
              <button className="text" onClick={() => setChecked(new Set())}>取消</button>
            </div>
          ) : (
            <div className="chips">
              {QUICK_FILTERS.map((f) => (
                <button key={f.token} className={input.split(/\s+/).includes(f.token) ? 'chip active' : 'chip'} onClick={() => toggleToken(f.token)}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="list-body">
        {error && <div className="list-error">{error}</div>}
        {loading && !all.length && (
          <div className="skeletons">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="skeleton-row">
                <div className="sk-avatar" />
                <div className="sk-lines"><div /><div /><div /></div>
              </div>
            ))}
          </div>
        )}
        {!loading && !all.length && !error && (
          <div className="empty">
            <Inbox size={42} strokeWidth={1.2} />
            <p>{q ? '没有找到匹配的邮件' : view.box === 'snoozed' ? '没有稍后处理的邮件' : view.box === 'label' ? '这个标签下还没有邮件' : '这里空空如也'}</p>
            {q && !deep && <button className="link-btn" onClick={() => onSearch(q, true)}>在服务器上搜索全文</button>}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="list-section"><Pin size={12} /> 置顶</div>
            {pinned.map((m) => <Row key={m.id} {...rowProps(m)} />)}
            {messages.length > 0 && <div className="list-section">其他邮件</div>}
          </>
        )}
        {messages.map((m) => <Row key={m.id} {...rowProps(m)} />)}
        {hasMore && (
          <div ref={sentinel} className="load-more">
            {loadingMore ? <><Loader2 size={14} className="spin" /> 正在加载更早的邮件…</> : ' '}
          </div>
        )}
      </div>
    </section>
  );
}
