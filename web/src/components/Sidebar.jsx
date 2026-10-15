import React, { useState } from 'react';
import {
  Inbox, Send, FileText, Trash2, Archive, ShieldAlert, Star, Folder, PenSquare, Settings, Sparkles, ChevronRight, Plus, LogOut,
  MailOpen, Clock, CalendarClock, AlertCircle, Loader2, FolderPlus, Layers, ListTodo, Search, Hourglass,
} from 'lucide-react';
import { avatarColor, folderDepth, folderLabel, initials, sortFolders } from '../utils.js';
import { BrandIcon } from './Brand.jsx';

const ICONS = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Trash': Trash2, '\\Archive': Archive, '\\Junk': ShieldAlert, '\\Flagged': Star, '\\All': Layers };

const SMART = [
  { box: 'today', label: '今日待办', icon: ListTodo },
  { box: 'waiting', label: '等待', icon: Hourglass },
  { box: 'inbox', label: '所有收件箱', icon: Inbox },
  { box: 'unread', label: '未读', icon: MailOpen },
  { box: 'flagged', label: '星标', icon: Star },
  { box: 'snoozed', label: '稍后处理', icon: Clock },
  { box: 'scheduled', label: '定时发送', icon: CalendarClock },
  { box: 'sent', label: '已发送', icon: Send },
  { box: 'drafts', label: '草稿箱', icon: FileText },
];

function loadExpanded() {
  try {
    return JSON.parse(localStorage.getItem('zm_expanded') || '{}');
  } catch {
    return {};
  }
}

export default function Sidebar({
  user, mailboxes, folders, counts, view, onView, onCompose, onDigest, onSettings, onAddMailbox, onLogout, onCommand, onNewFolder, open, onClose,
}) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [menu, setMenu] = useState(false);
  const multi = mailboxes.length > 1;

  const toggle = (id) => {
    const next = { ...expanded, [id]: !expanded[id] };
    setExpanded(next);
    localStorage.setItem('zm_expanded', JSON.stringify(next));
  };

  const go = (v) => {
    onView(v);
    onClose?.();
  };

  const smartCount = (box) => {
    if (box === 'today') return (counts.focus?.needReply || 0) + (counts.focus?.followups || 0);
    if (box === 'waiting') return (counts.focus?.needReply || 0) + (counts.focus?.followups || 0);
    if (box === 'inbox' || box === 'unread') return counts.unifiedUnread;
    if (box === 'snoozed') return counts.snoozed;
    if (box === 'scheduled') return counts.scheduled;
    return 0;
  };

  const isActive = (v) => view.box === v.box && (view.mailboxId || 'all') === (v.mailboxId || 'all') && (v.box !== 'folder' || view.folder === v.folder);

  return (
    <aside className={'sidebar' + (open ? ' open' : '')}>
      <div className="brand">
        <BrandIcon size={30} />
        <span className="brand-name">ZITO<small>智能邮箱</small></span>
        <div className="user-wrap">
          <button className="user-btn" onClick={() => setMenu((v) => !v)} title={user.email}>
            <span className="avatar xs" style={{ background: avatarColor(user.email) }}>{initials({ name: user.name, address: user.email })}</span>
          </button>
          {menu && (
            <div className="account-menu right" onMouseLeave={() => setMenu(false)}>
              <div className="menu-user">
                <b>{user.name}</b>
                <small>{user.email}</small>
              </div>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(false); onSettings('mailboxes'); }}><Settings size={15} /> 设置</button>
              <button onClick={onLogout} className="danger"><LogOut size={15} /> 退出登录</button>
            </div>
          )}
        </div>
      </div>

      <button className="compose-btn" onClick={() => onCompose()}>
        <PenSquare size={17} /> 写邮件
      </button>
      <button className="cmd-btn" onClick={onCommand}>
        <Search size={14} /> 搜索与命令 <kbd>Ctrl K</kbd>
      </button>
      <button className="digest-btn" onClick={onDigest}>
        <Sparkles size={16} /> AI 今日简报
      </button>

      <nav className="folders">
        {SMART.filter((s) => multi || !['sent', 'drafts'].includes(s.box)).map((s) => {
          const n = smartCount(s.box);
          const Icon = s.icon;
          const v = { mailboxId: 'all', box: s.box };
          return (
            <button key={s.box} className={'folder' + (isActive(v) ? ' active' : '') + (s.box === 'today' ? ' folder-today' : '')} onClick={() => go(v)}>
              <Icon size={17} />
              <span className="folder-name" title={s.box === 'waiting' ? '等我回复 · 等对方回复' : undefined}>{multi || s.box !== 'inbox' ? s.label : '收件箱'}</span>
              {(s.box === 'today' || s.box === 'waiting') && counts.focus?.overdue > 0 ? (
                <span className="count-pill alert" title={`${counts.focus.overdue} 封已超过回复时限`}>{n}</span>
              ) : (s.box === 'today' || s.box === 'waiting') && n > 0 ? (
                <span className="count-pill">{n}</span>
              ) : (
                n > 0 && <span className={'count' + (s.box === 'unread' || s.box === 'inbox' ? '' : ' muted')}>{n > 999 ? '999+' : n}</span>
              )}
            </button>
          );
        })}

        <div className="folder-group">
          <span>邮箱账号</span>
          <button className="mini-btn" title="绑定邮箱" onClick={onAddMailbox}><Plus size={14} /></button>
        </div>

        {mailboxes.map((mb) => {
          const list = sortFolders(folders[mb.id] || []);
          const inbox = list.find((f) => f.specialUse === '\\Inbox');
          const isOpen = expanded[mb.id] ?? !multi;
          return (
            <div key={mb.id} className="mb-group">
              <button className="mb-head" onClick={() => toggle(mb.id)} title={mb.email}>
                <ChevronRight size={14} className={'chev' + (isOpen ? ' open' : '')} />
                <span className="mb-dot" style={{ background: mb.color }} />
                <span className="folder-name">
                  <b>{mb.name || mb.email}</b>
                  <small>{mb.email}</small>
                </span>
                {mb.status === 'error' && <AlertCircle size={14} className="mb-err" title={mb.lastError} />}
                {(mb.status === 'syncing' || mb.status === 'new') && <Loader2 size={13} className="spin muted-icon" />}
                {!isOpen && inbox?.unseen > 0 && <span className="count">{inbox.unseen}</span>}
              </button>
              {mb.status === 'error' && isOpen && (
                <button className="mb-error" onClick={() => onSettings('mailboxes', mb.id)}>
                  {mb.lastError || '连接失败'} · 点击修复
                </button>
              )}
              {isOpen &&
                list.map((f) => {
                  const Icon = ICONS[f.specialUse] || Folder;
                  const v = { mailboxId: mb.id, box: 'folder', folder: f.path };
                  const showCount = f.unseen > 0 && !['\\Sent', '\\Trash', '\\Drafts', '\\Junk', '\\All'].includes(f.specialUse);
                  return (
                    <button
                      key={f.path}
                      className={'folder sub' + (isActive(v) ? ' active' : '')}
                      style={{ paddingLeft: 30 + folderDepth(f) * 12 }}
                      onClick={() => go(v)}
                      title={f.path}
                    >
                      <Icon size={15} />
                      <span className="folder-name">{folderLabel(f)}</span>
                      {showCount && <span className="count">{f.unseen > 999 ? '999+' : f.unseen}</span>}
                      {f.specialUse === '\\Drafts' && f.total > 0 && <span className="count muted">{f.total}</span>}
                    </button>
                  );
                })}
              {isOpen && (
                <button className="folder sub add-folder" style={{ paddingLeft: 30 }} onClick={() => onNewFolder(mb)}>
                  <FolderPlus size={14} /> <span className="folder-name">新建文件夹</span>
                </button>
              )}
            </div>
          );
        })}
      </nav>

      <button className="folder settings-link" onClick={() => onSettings('preferences')}>
        <Settings size={17} /> <span className="folder-name">设置</span>
      </button>
    </aside>
  );
}
