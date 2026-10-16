import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Inbox, ListTodo, MailOpen, Star, Send, PenSquare, CornerUpLeft, CheckCircle2, Clock, FileText, Briefcase, Hourglass } from 'lucide-react';
import { displayName } from '../utils.js';

const ICONS = { today: ListTodo, waiting: Hourglass, deals: Briefcase, inbox: Inbox, unread: MailOpen, flagged: Star, sent: Send, drafts: FileText, compose: PenSquare, reply: CornerUpLeft, done: CheckCircle2, snooze: Clock };

/**
 * 命令面板：搜索当前列表里的邮件，或直接跳转、写信、处理。Ctrl/⌘ K 打开。
 */
export default function Palette({ open, messages, hasSelection, onClose, onOpen, onGo, onCompose, onReply, onDone, onSnooze }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef();

  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    setTimeout(() => input.current?.focus(), 30);
  }, [open]);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const commands = [
      { kind: 'cmd', id: 'compose', label: '写邮件', hint: 'C', run: onCompose },
      { kind: 'cmd', id: 'today', label: '前往今日待办', hint: 'G T', run: () => onGo('today') },
      { kind: 'cmd', id: 'waiting', label: '前往等待', hint: 'G W', run: () => onGo('waiting') },
      { kind: 'cmd', id: 'deals', label: '我的客户', hint: 'G D', run: () => onGo('deals') },
      { kind: 'cmd', id: 'inbox', label: '前往收件箱', hint: 'G I', run: () => onGo('inbox') },
      { kind: 'cmd', id: 'unread', label: '只看未读', run: () => onGo('unread') },
      { kind: 'cmd', id: 'flagged', label: '星标邮件', run: () => onGo('flagged') },
      { kind: 'cmd', id: 'sent', label: '已发送', run: () => onGo('sent') },
      { kind: 'cmd', id: 'drafts', label: '草稿箱', run: () => onGo('drafts') },
    ];
    if (hasSelection) {
      commands.unshift(
        { kind: 'cmd', id: 'reply', label: '回复当前邮件', hint: 'R', run: onReply },
        { kind: 'cmd', id: 'done', label: '标记已处理', hint: 'D', run: onDone },
        { kind: 'cmd', id: 'snooze', label: '稍后提醒到明天', hint: 'B', run: onSnooze },
      );
    }
    const hay = (m) => [m.subject, m.snippet, m.from?.name, m.from?.address, m.to?.[0]?.name, m.to?.[0]?.address, m.priority?.company?.name].filter(Boolean).join(' ').toLowerCase();
    const mails = (query ? messages.filter((m) => hay(m).includes(query)) : []).slice(0, 6).map((m) => ({
      kind: 'mail',
      id: 'm' + m.id,
      label: m.subject || '(无主题)',
      sub: displayName(m.from) || displayName(m.to?.[0]) || '',
      run: () => onOpen(m),
    }));
    const cmds = commands.filter((c) => !query || c.label.toLowerCase().includes(query));
    return [...mails, ...cmds];
  }, [q, messages, hasSelection, onCompose, onGo, onReply, onDone, onSnooze, onOpen]);

  useEffect(() => setCursor(0), [q]);

  if (!open) return null;
  const run = (item) => item && item.run();

  return (
    <div className="palette-mask" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="搜索与命令">
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            value={q}
            placeholder="搜索邮件，或输入命令：今日待办、写邮件、回复…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(items[cursor]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              e.stopPropagation();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">没有匹配的邮件或命令</div>}
          {items.map((item, i) => {
            const Icon = item.kind === 'mail' ? MailOpen : ICONS[item.id] || Search;
            return (
              <button key={item.id} className={'palette-item' + (i === cursor ? ' on' : '')} onMouseEnter={() => setCursor(i)} onClick={() => run(item)}>
                <Icon size={15} />
                <span className="pi-label">{item.label}</span>
                {item.sub && <small className="pi-sub">{item.sub}</small>}
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            );
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span>输入文字即搜索当前列表</span></div>
      </div>
    </div>
  );
}
