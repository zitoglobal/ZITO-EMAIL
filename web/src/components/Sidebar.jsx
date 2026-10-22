import React, { useState } from 'react';
import {
  Inbox, Send, FileText, Trash2, Archive, ShieldAlert, Star, Folder, PenSquare, Settings, Sparkles, ChevronRight, Plus, LogOut,
  MailOpen, Clock, CalendarClock, AlertCircle, Loader2, FolderPlus, Layers, ListTodo, Search, LayoutPanelLeft,
  Columns3,   Briefcase, BookOpen, PanelLeft, Rows3, Tag, Bookmark, MoreHorizontal, Pencil, Trash, ChevronDown, BarChart3, Users,
} from 'lucide-react';
import { avatarColor, folderDepth, folderLabel, initials, sortFolders } from '../utils.js';
import { ICON_LG, ICON_MD, ICON_SM, Icon, ip } from '../uiIcons.jsx';
import { BrandIcon } from './Brand.jsx';
import { LAYOUT_MODES } from '../layout.js';

const MODE_ICONS = { standard: Columns3, sales: Briefcase, focus: BookOpen, wide: PanelLeft, board: Rows3 };

const ICONS = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Trash': Trash2, '\\Archive': Archive, '\\Junk': ShieldAlert, '\\Flagged': Star, '\\All': Layers };

/** L0 工作 — always visible (and icon-rail)；等待已并入今日待办桶 */
const WORK = [
  { box: 'today', label: '今日待办', icon: ListTodo },
  { box: 'team', label: '团队公海', icon: Users },
  { box: 'deals', label: '我的客户', icon: Briefcase },
  { box: 'insights', label: '销售洞察', icon: BarChart3 },
  { box: 'unread', label: '未读', icon: MailOpen },
];

/** L1 信箱 — classic path */
const MAILBOX_PRIMARY = [
  { box: 'inbox', label: '所有收件箱', icon: Inbox },
  { box: 'flagged', label: '星标', icon: Star },
];

/** L2 更多 — collapsed by default */
const MAILBOX_MORE = [
  { box: 'snoozed', label: '稍后处理', icon: Clock },
  { box: 'scheduled', label: '发送队列', icon: CalendarClock },
  { box: 'sent', label: '已发送', icon: Send, multiOnly: true },
  { box: 'drafts', label: '草稿箱', icon: FileText, multiOnly: true },
];

/** Focus icon-rail：今日·公海·客户·收件箱·未读 */
const RAIL_ITEMS = [
  { box: 'today', label: '今日待办', icon: ListTodo },
  { box: 'team', label: '团队公海', icon: Users },
  { box: 'deals', label: '我的客户', icon: Briefcase },
  { box: 'inbox', label: '所有收件箱', icon: Inbox },
  { box: 'unread', label: '未读', icon: MailOpen },
];

function loadExpanded() {
  try {
    return JSON.parse(localStorage.getItem('zm_expanded') || '{}');
  } catch {
    return {};
  }
}

function fmtCount(n) {
  if (!n || n <= 0) return null;
  return n > 999 ? '999+' : n;
}

export default function Sidebar({
  user, mailboxes, folders, counts, view, onView, onCompose, onDigest, onSettings, onAddMailbox, onLogout, onCommand, onNewFolder, open, onClose,
  iconRail = false, layoutMode = 'standard', onLayoutMode, salesRailTip = false,
  labels = [], onCreateLabel,
  savedSearches = [], onOpenSavedSearch, onCreateSavedSearch, onEditSavedSearch, onDeleteSavedSearch,
}) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [menu, setMenu] = useState(false);
  const [ssMenu, setSsMenu] = useState(null);
  const multi = mailboxes.length > 1;
  const moreOpen = expanded['mailbox-more'] === true;

  const toggle = (id) => {
    const next = { ...expanded, [id]: !expanded[id] };
    setExpanded(next);
    localStorage.setItem('zm_expanded', JSON.stringify(next));
  };

  const go = (v) => {
    onView(v);
    onClose?.();
  };

  /**
   * Counts:
   * - today: needReply+followups; overdue → alert pill
   * - waiting: waitingMine + waitingThem
   * - team: 公海 total；overdue → alert pill
   * - unread: unifiedUnread；inbox 不挂未读角标
   */
  const smartCount = (box) => {
    // 侧栏角标优先「今日未回」；没有则回退待回+跟进
    if (box === 'today') {
      const tu = counts.focus?.todayUnreplied;
      if (typeof tu === 'number' && tu > 0) return tu;
      return (counts.focus?.needReply || 0) + (counts.focus?.followups || 0);
    }
    if (box === 'waiting') {
      const mine = counts.focus?.waitingMine;
      const them = counts.focus?.waitingThem;
      if (typeof mine === 'number' || typeof them === 'number') return (mine || 0) + (them || 0);
      return 0;
    }
    if (box === 'team') return counts.team?.total || 0;
    if (box === 'unread') return counts.unifiedUnread || 0;
    if (box === 'inbox') return 0;
    if (box === 'snoozed') return counts.snoozed || 0;
    if (box === 'scheduled') return counts.scheduled || 0;
    return 0;
  };

  const isActive = (v) =>
    view.box === v.box &&
    (view.mailboxId || 'all') === (v.mailboxId || 'all') &&
    (v.box !== 'folder' || view.folder === v.folder) &&
    (v.box !== 'label' || Number(view.labelId) === Number(v.labelId)) &&
    (v.box !== 'smart' || Number(view.smartId) === Number(v.smartId));

  const renderSmart = (s) => {
    const n = smartCount(s.box);
    const SmartIcon = s.icon;
    const v = { mailboxId: 'all', box: s.box };
    const active = isActive(v);
    const label = multi || s.box !== 'inbox' ? s.label : '收件箱';
    const overdue =
      (s.box === 'today' && (counts.focus?.overdue > 0 || counts.focus?.todayUnreplied > 0)) ||
      (s.box === 'team' && counts.team?.overdue > 0) ||
      (s.box === 'scheduled' && (counts.outboxFailed || 0) > 0);
    const waitingSplit =
      s.box === 'waiting' &&
      (typeof counts.focus?.waitingMine === 'number' || typeof counts.focus?.waitingThem === 'number');
    const countLabel = fmtCount(n);
    const showPill =
      (s.box === 'today' || s.box === 'waiting' || s.box === 'team' || s.box === 'scheduled') && n > 0;
    const todayTitle =
      s.box === 'today'
        ? `今日未回 ${counts.focus?.todayUnreplied || 0} · 待回 ${counts.focus?.needReply || 0} · 超时 ${counts.focus?.overdue || 0} · 跟进 ${counts.focus?.followups || 0}`
        : null;
    const showCount = !showPill && countLabel != null;

    return (
      <button
        key={s.box}
        type="button"
        className={
          'folder' +
          (active ? ' active' : '') +
          (s.box === 'today' ? ' folder-today' : '') +
          (s.box === 'waiting' ? ' folder-waiting' : '') +
          (s.box === 'team' ? ' folder-team' : '')
        }
        onClick={() => go(v)}
        title={
          todayTitle ||
          (s.box === 'waiting'
            ? waitingSplit
              ? `等我 ${counts.focus.waitingMine || 0} · 等对方 ${counts.focus.waitingThem || 0}`
              : '等我回复 · 等对方回复'
            : s.box === 'team'
              ? counts.team
                ? `公海 ${counts.team.total || 0}${counts.team.overdue ? ` · 超时 ${counts.team.overdue}` : ''}${counts.team.vip ? ` · VIP ${counts.team.vip}` : ''}`
                : '未认领客户来信'
              : label)
        }
        aria-label={todayTitle || label}
        aria-current={active ? 'page' : undefined}
      >
        <SmartIcon {...ICON_LG} />
        <span className="folder-name">{label}</span>
        {overdue ? (
          <span
            className="count-pill alert"
            title={
              s.box === 'scheduled'
                ? `${counts.outboxFailed} 封发送失败，点此重试`
                : s.box === 'team'
                  ? `${counts.team.overdue} 条公海已超时未认领`
                  : `${counts.focus.overdue} 封已超过回复时限`
            }
          >
            {countLabel}
          </span>
        ) : showPill ? (
          <span className="count-pill">{countLabel}</span>
        ) : (
          showCount && (
            <span className={'count' + (s.box === 'unread' ? '' : ' muted')}>{countLabel}</span>
          )
        )}
      </button>
    );
  };

  const moreItems = MAILBOX_MORE.filter((s) => !s.multiOnly || multi);

  return (
    <aside className={'sidebar' + (open ? ' open' : '') + (iconRail ? ' icon-rail' : '')}>
      <div className="brand">
        <BrandIcon size={iconRail ? 26 : 30} />
        {!iconRail && <span className="brand-name">ZITO<small>智能邮箱</small></span>}
        <div className="user-wrap">
          <button className="user-btn" onClick={() => setMenu((v) => !v)} title={user.email} aria-label="账户菜单">
            <span className="avatar xs" style={{ background: avatarColor(user.email) }}>{initials({ name: user.name, address: user.email })}</span>
          </button>
          {menu && (
            <div className="account-menu right" onMouseLeave={() => setMenu(false)}>
              <div className="menu-user">
                <b>{user.name}</b>
                <small>{user.email}</small>
              </div>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(false); onSettings('mailboxes'); }}><Icon as={Settings} {...ICON_MD} /> 设置</button>
              <button onClick={onLogout} className="danger"><Icon as={LogOut} {...ICON_MD} /> 退出登录</button>
            </div>
          )}
        </div>
      </div>

      <button className="compose-btn" onClick={() => onCompose()} title="写邮件" aria-label="写邮件">
        <Icon as={PenSquare} {...ICON_LG} />{!iconRail && ' 写邮件'}
      </button>

      {/* Search: secondary ghost; hide in icon-rail (⌘K still works) */}
      {!iconRail && (
        <button className="cmd-btn" onClick={onCommand} title="搜索与命令" aria-label="搜索与命令">
          <Icon as={Search} {...ICON_SM} /> 搜索与命令 <kbd>⌘K</kbd>
        </button>
      )}

      {/* AI digest: link style, cyan sparkle — not in rail */}
      {!iconRail && (
        <button className="digest-link" onClick={onDigest} title="AI 今日简报" aria-label="AI 今日简报">
          <Icon as={Sparkles} {...ip(14, 1.6)} /> AI 今日简报
        </button>
      )}

      <nav className="folders">
        {iconRail ? (
          /* Focus rail: render-filter to 5 items — not CSS-only hide */
          RAIL_ITEMS.map(renderSmart)
        ) : (
          <>
            <div className="folder-group">
              <span>工作</span>
            </div>
            {WORK.map(renderSmart)}

            <div className="folder-group">
              <span>信箱</span>
            </div>
            {MAILBOX_PRIMARY.map(renderSmart)}

            <button
              type="button"
              className={'folder sub folder-more-toggle' + (moreOpen ? ' open' : '')}
              onClick={() => toggle('mailbox-more')}
              aria-expanded={moreOpen}
            >
              {moreOpen ? <Icon as={ChevronDown} {...ICON_MD} /> : <Icon as={ChevronRight} {...ICON_MD} />}
              <span className="folder-name">更多</span>
            </button>
            {moreOpen && moreItems.map(renderSmart)}

            <div className="folder-group">
              <span>标签</span>
              <button
                className="mini-btn"
                title="新建标签"
                onClick={() => {
                  if (onCreateLabel) onCreateLabel();
                  else onSettings?.('labels');
                }}
              ><Icon as={Plus} {...ICON_SM} /></button>
            </div>
            {!labels.length && (
              <button className="folder sub label-empty-hint" onClick={() => onSettings?.('labels')} title="管理标签">
                <Icon as={Tag} {...ICON_MD} />
                <span className="folder-name muted-text">添加标签整理邮件</span>
              </button>
            )}
            {labels.map((l) => {
              const v = { mailboxId: 'all', box: 'label', labelId: l.id };
              const active = isActive(v);
              return (
                <button
                  key={l.id}
                  type="button"
                  className={'folder sub' + (active ? ' active' : '')}
                  onClick={() => go(v)}
                  title={l.name}
                  aria-label={`标签 ${l.name}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="label-dot" style={{ background: l.color }} />
                  <span className="folder-name">{l.name}</span>
                  {l.count > 0 && <span className="count muted">{l.count > 999 ? '999+' : l.count}</span>}
                </button>
              );
            })}
            {labels.length > 0 && (
              <button type="button" className="folder sub add-folder" onClick={() => onSettings?.('labels')}>
                <Icon as={Tag} {...ICON_SM} /> <span className="folder-name">管理标签</span>
              </button>
            )}

            <div className="folder-group">
              <span>智能文件夹</span>
              <button
                className="mini-btn"
                title="新建智能文件夹"
                onClick={() => onCreateSavedSearch?.()}
              ><Icon as={Plus} {...ICON_SM} /></button>
            </div>
            {!savedSearches.length && (
              <button className="folder sub label-empty-hint" onClick={() => onCreateSavedSearch?.()} title="保存常用搜索">
                <Icon as={Bookmark} {...ICON_MD} />
                <span className="folder-name muted-text">保存常用搜索，一键回到「有附件」「某客户」</span>
              </button>
            )}
            {savedSearches.filter((s) => s.pinned !== false).map((s) => {
              const v = { mailboxId: 'all', box: 'smart', smartId: s.id };
              const active = isActive(v);
              return (
                <div key={s.id} className={'folder-row' + (active ? ' active-row' : '')}>
                  <button
                    type="button"
                    className={'folder sub' + (active ? ' active' : '')}
                    onClick={() => onOpenSavedSearch ? onOpenSavedSearch(s) : go(v)}
                    title={s.query}
                    aria-label={`智能文件夹 ${s.name}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon as={Bookmark} {...ICON_MD} />
                    <span className="folder-name">{s.name}</span>
                  </button>
                  <div className="folder-more-wrap">
                    <button
                      type="button"
                      className="folder-more"
                      title="管理"
                      aria-label={`管理 ${s.name}`}
                      onClick={(e) => { e.stopPropagation(); setSsMenu(ssMenu === s.id ? null : s.id); }}
                    >
                      <Icon as={MoreHorizontal} {...ICON_SM} />
                    </button>
                    {ssMenu === s.id && (
                      <div className="account-menu folder-ss-menu" onMouseLeave={() => setSsMenu(null)}>
                        <button type="button" onClick={() => { setSsMenu(null); onEditSavedSearch?.(s); }}>
                          <Icon as={Pencil} {...ICON_SM} /> 重命名 / 编辑查询
                        </button>
                        <button type="button" onClick={() => { setSsMenu(null); onOpenSavedSearch?.(s); }}>
                          <Icon as={Search} {...ICON_SM} /> 打开并搜索
                        </button>
                        <button type="button" className="danger" onClick={() => { setSsMenu(null); onDeleteSavedSearch?.(s); }}>
                          <Icon as={Trash} {...ICON_SM} /> 删除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="folder-group">
              <span>邮箱账号</span>
              <button className="mini-btn" title="绑定邮箱" onClick={onAddMailbox}><Icon as={Plus} {...ICON_SM} /></button>
            </div>

            {mailboxes.map((mb) => {
              const list = sortFolders(folders[mb.id] || []);
              const inbox = list.find((f) => f.specialUse === '\\Inbox');
              const isOpen = expanded[mb.id] ?? !multi;
              return (
                <div key={mb.id} className="mb-group">
                  <button type="button" className="mb-head" onClick={() => toggle(mb.id)} title={mb.email}>
                    <Icon as={ChevronRight} {...ICON_SM} className={'chev' + (isOpen ? ' open' : '')} />
                    <span className="mb-dot" style={{ background: mb.color }} />
                    <span className="folder-name">
                      <b>{mb.name || mb.email}</b>
                      <small>{mb.email}</small>
                    </span>
                    {mb.status === 'error' && <Icon as={AlertCircle} {...ICON_SM} className="mb-err" title={mb.lastError} />}
                    {(mb.status === 'syncing' || mb.status === 'new') && <Icon as={Loader2} {...ip(13)} className="spin muted-icon" />}
                    {!isOpen && inbox?.unseen > 0 && <span className="count">{inbox.unseen}</span>}
                  </button>
                  {mb.status === 'error' && isOpen && (
                    <button type="button" className="mb-error" onClick={() => onSettings('mailboxes', mb.id)}>
                      {mb.lastError || '连接失败'} · 点击修复
                    </button>
                  )}
                  {isOpen &&
                    list.map((f) => {
                      const FolderIcon = ICONS[f.specialUse] || Folder;
                      const v = { mailboxId: mb.id, box: 'folder', folder: f.path };
                      const active = isActive(v);
                      const showCount = f.unseen > 0 && !['\\Sent', '\\Trash', '\\Drafts', '\\Junk', '\\All'].includes(f.specialUse);
                      return (
                        <button
                          key={f.path}
                          type="button"
                          className={'folder sub' + (active ? ' active' : '')}
                          style={{ paddingLeft: 30 + folderDepth(f) * 12 }}
                          onClick={() => go(v)}
                          title={f.path}
                          aria-current={active ? 'page' : undefined}
                        >
                          <FolderIcon {...ICON_MD} />
                          <span className="folder-name">{folderLabel(f)}</span>
                          {showCount && <span className="count">{f.unseen > 999 ? '999+' : f.unseen}</span>}
                          {f.specialUse === '\\Drafts' && f.total > 0 && <span className="count muted">{f.total}</span>}
                        </button>
                      );
                    })}
                  {isOpen && (
                    <button type="button" className="folder sub add-folder" style={{ paddingLeft: 30 }} onClick={() => onNewFolder(mb)}>
                      <Icon as={FolderPlus} {...ICON_SM} /> <span className="folder-name">新建文件夹</span>
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
      </nav>

      {onLayoutMode && (
        <div className="layout-mode-switch" role="group" aria-label="布局模式">
          {!iconRail && (
            <div className="layout-mode-label"><Icon as={LayoutPanelLeft} {...ip(13)} /> 布局</div>
          )}
          <div className="layout-mode-btns">
            {LAYOUT_MODES.map((m) => {
              const ModeIcon = MODE_ICONS[m.id] || Columns3;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={layoutMode === m.id ? 'on' : ''}
                  title={m.label + ' · ' + m.hint}
                  aria-pressed={layoutMode === m.id}
                  aria-label={m.label}
                  onClick={() => onLayoutMode(m.id)}
                >
                  <ModeIcon {...ip(iconRail ? 16 : 13)} />
                  {!iconRail && <span>{m.short || m.label}</span>}
                </button>
              );
            })}
          </div>
          {salesRailTip && !iconRail && (
            <p className="layout-mode-tip" role="note">需更宽窗口才显示客户栏</p>
          )}
          {salesRailTip && iconRail && (
            <p className="layout-mode-tip icon-tip" role="note" title="需更宽窗口才显示客户栏">宽屏</p>
          )}
        </div>
      )}

      <button type="button" className="folder settings-link" onClick={() => onSettings('preferences')} title="设置" aria-label="设置">
        <Icon as={Settings} {...ICON_LG} /> <span className="folder-name">设置</span>
      </button>
    </aside>
  );
}
