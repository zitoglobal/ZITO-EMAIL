import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X, LogOut, Keyboard, ListTodo, Inbox, PenSquare, AlertCircle, RefreshCw, Hourglass, Clock, Menu } from 'lucide-react';
import { api, qs } from './api.js';
import Auth, { HeroBrand } from './components/Auth.jsx';
import { BrandIcon } from './components/Brand.jsx';
import MailboxForm from './components/MailboxForm.jsx';
import Sidebar from './components/Sidebar.jsx';
import MailList from './components/MailList.jsx';
import Reader from './components/Reader.jsx';
import Composer from './components/Composer.jsx';
import Outbox from './components/Outbox.jsx';
import Digest from './components/Digest.jsx';
import Settings from './components/Settings.jsx';
import Focus from './components/Focus.jsx';
import Waiting from './components/Waiting.jsx';
import AdminEmpty from './components/AdminEmpty.jsx';
import Deals from './components/Deals.jsx';
import Insights from './components/Insights.jsx';
import TeamQueue from './components/TeamQueue.jsx';
import CustomerPanel from './components/CustomerPanel.jsx';
import ColumnSplitter from './components/ColumnSplitter.jsx';
import Palette from './components/Palette.jsx';
import SaveSearchModal from './components/SaveSearchModal.jsx';
import { SMART_VIEWS, dayStart, folderLabel, formatShortDateTime, orderFocus, sanitizeHtml, snoozePresets } from './utils.js';
import { buildComposeState, signatureHtml, toForm } from './compose.js';
import {
  LAYOUT_LIMITS,
  effectiveWidths,
  loadLayoutLocal,
  normalizeLayoutMode,
  saveLayoutLocal,
  widthsFromSettings,
} from './layout.js';
import { ACTION_TEXT, DEFAULT_VIEW, followUpAiForStage, followUpBodyForStage, PAGE, REMOVING, SHORTCUTS, UNDO_OF } from './appConstants.js';
import { useRealtimeMail } from './hooks/useRealtimeMail.js';
import { useAppBoot } from './hooks/useAppBoot.js';

function mergeLocalLabels(current = [], add = [], remove = [], allLabels = []) {
  const byId = new Map((current || []).map((l) => [l.id, l]));
  for (const id of remove.map(Number)) byId.delete(id);
  for (const id of add.map(Number)) {
    if (byId.has(id)) continue;
    const meta = allLabels.find((l) => l.id === id);
    if (meta) byId.set(id, { id: meta.id, name: meta.name, color: meta.color });
  }
  return [...byId.values()];
}

function loadView() {
  try {
    // 大师设计 P0-1：一次性把默认主页迁到「今日待办」（用户之后仍可手动切回收件箱并记住）
    if (!localStorage.getItem('zm_craft_home_v1')) {
      localStorage.setItem('zm_craft_home_v1', '1');
      localStorage.setItem('zm_view', JSON.stringify(DEFAULT_VIEW));
      return { ...DEFAULT_VIEW };
    }
    return JSON.parse(localStorage.getItem('zm_view')) || DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export default function App() {
  const [boot, setBoot] = useState('loading');
  const [user, setUser] = useState(null);
  const [ai, setAi] = useState(false);
  const [mailboxes, setMailboxes] = useState([]);
  const [folders, setFolders] = useState({});
  const [counts, setCounts] = useState({ unifiedUnread: 0, snoozed: 0, scheduled: 0 });
  const [labels, setLabels] = useState([]);
  const [savedSearches, setSavedSearches] = useState([]);
  const [saveSearchModal, setSaveSearchModal] = useState(null); // { mode, name, query, id? }
  const [searchPresets, setSearchPresets] = useState([]);

  const [view, setViewState] = useState(loadView);
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  const [deep, setDeep] = useState(false);
  const [list, setList] = useState({ messages: [], pinned: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [palette, setPalette] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const [currentMsg, setCurrentMsg] = useState(null);

  const [composers, setComposers] = useState([]);
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [outboxVersion, setOutboxVersion] = useState(0);
  const [dealsVersion, setDealsVersion] = useState(0);
  const [focusData, setFocusData] = useState(null);
  const [groupMode, setGroupModeState] = useState(() => localStorage.getItem('zm_group') || 'priority');
  const [aiBusy, setAiBusy] = useState(false);
  const [waitingTab, setWaitingTab] = useState('mine');
  const [customerOpen, setCustomerOpen] = useState(false); // drawer when rail hidden
  const [customerCtx, setCustomerCtx] = useState(null); // { address, sender, slaHours }
  const [viewportW, setViewportW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  const localLayout = useMemo(() => loadLayoutLocal(), []);
  const [layoutMode, setLayoutModeState] = useState(() => localLayout?.mode || 'standard');
  const [layoutWidths, setLayoutWidths] = useState(() => localLayout?.widths || {
    sidebar: LAYOUT_LIMITS.sidebar.def,
    list: LAYOUT_LIMITS.list.def,
    customer: LAYOUT_LIMITS.customer.def,
  });
  const layoutSaveTimer = useRef(null);
  const layoutWidthsRef = useRef(layoutWidths);
  layoutWidthsRef.current = layoutWidths;
  const groupRef = useRef(groupMode);
  groupRef.current = groupMode;

  const reqId = useRef(0);
  const listRef = useRef(list);
  listRef.current = list;
  const settings = user?.settings || {};

  const mailboxMap = useMemo(() => Object.fromEntries(mailboxes.map((m) => [m.id, m])), [mailboxes]);
  const currentFolder = view.box === 'folder' ? (folders[view.mailboxId] || []).find((f) => f.path === view.folder) : null;
  const special = currentFolder?.specialUse;
  const isDraftsView = view.box === 'drafts' || special === '\\Drafts';
  const showCategories = view.box === 'inbox' || special === '\\Inbox';
  const allItems = useMemo(() => [...list.pinned, ...list.messages], [list]);
  const selectedItem = allItems.find((m) => m.id === selectedId) || null;

  // ---------- 通知 ----------
  const notify = useCallback((text, type = 'info', action, ttl = 4000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, type, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
    return id;
  }, []);
  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  const railAllowed = layoutMode === 'sales' && viewportW >= LAYOUT_LIMITS.salesRailMinViewport;
  const openCustomer = useCallback((address, detailOrSender) => {
    const sender = detailOrSender?.sender
      ? { ...detailOrSender.sender, address: address || detailOrSender.sender.address }
      : detailOrSender?.from
        ? null
        : detailOrSender;
    const slaHours = selectedItem?.priority?.slaHours;
    setCustomerCtx({
      address: address || sender?.address,
      sender: sender || (detailOrSender?.sender ? { ...detailOrSender.sender, address } : null),
      slaHours,
      detail: detailOrSender?.sender ? detailOrSender : null,
    });
    if (!(layoutMode === 'sales' && viewportW >= LAYOUT_LIMITS.salesRailMinViewport)) setCustomerOpen(true);
  }, [layoutMode, viewportW, selectedItem]);

  async function setCustomerRule(key, kind, name) {
    try {
      if (kind) await api('/sender-rules', { method: 'POST', body: { key, kind, name } });
      else await api('/sender-rules?key=' + encodeURIComponent(key), { method: 'DELETE' });
      notify(kind === 'vip' ? `已设为 VIP 客户：${key}` : kind === 'muted' ? `已静音 ${key}，其来信不再进入今日待办` : '已移除规则');
      // refresh selected message if any
      if (selectedId) {
        try {
          const d = await api(`/messages/${selectedId}`);
          setCurrentMsg(d);
          if (customerCtx) {
            setCustomerCtx((c) => c && {
              ...c,
              sender: d.sender ? { ...d.sender, address: c.address || d.sender.address || d.from?.address } : c.sender,
            });
          }
        } catch {}
      }
    } catch (e) {
      notify(e.message, 'error');
    }
  }


  // ---------- 主题 ----------
  useEffect(() => {
    const apply = () => {
      const t = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme || 'light';
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (settings.theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 从用户设置恢复布局（与 localStorage 双写，设置优先）
  useEffect(() => {
    if (!user?.settings) return;
    const s = user.settings;
    if (s.layoutMode) setLayoutModeState(normalizeLayoutMode(s.layoutMode));
    if (s.layoutSidebar != null || s.layoutList != null || s.layoutCustomer != null) {
      setLayoutWidths(widthsFromSettings(s));
    }
  }, [user?.id]); // 仅登录/切换用户时灌入


  useEffect(() => {
    document.title = counts.unifiedUnread ? `(${counts.unifiedUnread}) ZITO 智能邮箱` : 'ZITO 智能邮箱';
    const pending = (counts.focus?.needReply || 0) + (counts.focus?.followups || 0);
    if ('setAppBadge' in navigator) (pending ? navigator.setAppBadge(pending) : navigator.clearAppBadge()).catch(() => {});
  }, [counts.unifiedUnread, counts.focus?.needReply, counts.focus?.followups]);

  // ---------- 状态 ----------
  const applyState = useCallback((s) => {
    setMailboxes(s.mailboxes);
    setFolders(s.folders);
    setCounts(s.counts);
    if (s.labels) setLabels(s.labels);
    if (s.savedSearches) setSavedSearches(s.savedSearches);
  }, []);

  const loadState = useCallback(async () => {
    try {
      applyState(await api('/state' + qs({ dayStart: dayStart() })));
    } catch (e) {
      if (e.status === 401) setBoot('auth');
    }
  }, [applyState]);

  function setView(v) {
    setViewState(v);
    localStorage.setItem('zm_view', JSON.stringify(v));
    setSelectedId(null);
    setChecked(new Set());
    setCategory('all');
    setQ('');
    setDeep(false);
  }

  useAppBoot({ applyState, setUser, setAi, setBoot, setQ, setViewState: setView, notify });

  // 视图引用的邮箱/文件夹不存在时回到默认视图
  useEffect(() => {
    if (boot !== 'ready' || !mailboxes.length) return;
    if (view.mailboxId !== 'all' && !mailboxMap[view.mailboxId]) setView(DEFAULT_VIEW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, mailboxes]);

  useEffect(() => {
    if (boot !== 'ready') return;
    api('/saved-searches')
      .then((d) => {
        if (d.savedSearches) setSavedSearches(d.savedSearches);
        if (d.presets) setSearchPresets(d.presets);
      })
      .catch(() => {});
  }, [boot]);

  /** 通知点达：切换视图时保留目标邮件选中 */
  const openMessage = useCallback((id, { box = 'today', mailboxId = 'all' } = {}) => {
    if (!id) return;
    const next = { mailboxId, box };
    setViewState(next);
    localStorage.setItem('zm_view', JSON.stringify(next));
    setChecked(new Set());
    setCategory('all');
    setQ('');
    setDeep(false);
    setSelectedId(id);
    setSidebarOpen(false);
  }, []);

  const goToday = useCallback(() => {
    setView({ mailboxId: 'all', box: 'today' });
  }, []);

  // ---------- 列表 ----------
  const loadList = useCallback(
    async ({ append = false, silent = false } = {}) => {
        if (view.box === 'scheduled' || view.box === 'deals' || view.box === 'team' || view.box === 'insights') return;
      if (view.box === 'today' || view.box === 'waiting') {
        if (append) return;
        const id = ++reqId.current;
        if (!silent) setLoading(true);
        setListError('');
        try {
          const d = await api('/focus' + qs({ mailboxId: view.mailboxId || 'all', dayStart: dayStart() }));
          if (id !== reqId.current) return;
          setFocusData(d);
          const items = [...d.reply.map((m) => ({ ...m, _section: 'reply' })), ...d.followups.map((m) => ({ ...m, _section: 'follow' }))];
          setList({ messages: orderFocus(items, groupRef.current), pinned: [], nextCursor: null });
        } catch (e) {
          if (id !== reqId.current) return;
          if (e.status === 401) return setBoot('auth');
          if (!silent) setListError(e.message);
        } finally {
          if (id === reqId.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
        return;
      }
      const id = ++reqId.current;
      const prev = listRef.current;
      if (append) {
        if (!prev.nextCursor) return;
        setLoadingMore(true);
      } else if (!silent) setLoading(true);
      setListError('');
      const limit = silent ? Math.min(100, Math.max(PAGE, prev.messages.length)) : PAGE;
      try {
        const data = await api(
          '/messages' +
            qs({
              mailboxId: view.mailboxId || 'all',
              box: view.box,
              folder: view.folder,
              labelId: view.box === 'label' ? view.labelId : undefined,
              smartId: view.box === 'smart' ? view.smartId : undefined,
              category: showCategories && category !== 'all' && !q ? category : undefined,
              q,
              deep: deep && q ? 1 : undefined,
              cursor: append ? prev.nextCursor : undefined,
              limit,
            })
        );
        if (id !== reqId.current) return;
        setList((p) => {
          if (append) {
            const have = new Set(p.messages.map((m) => m.id));
            return { ...p, messages: [...p.messages, ...data.messages.filter((m) => !have.has(m.id))], nextCursor: data.nextCursor };
          }
          if (silent && p.messages.length > data.messages.length && data.nextCursor) {
            const fresh = new Set(data.messages.map((m) => m.id));
            const lastTs = data.messages[data.messages.length - 1]?.sortTs ?? Infinity;
            const tail = p.messages.filter((m) => !fresh.has(m.id) && m.sortTs < lastTs);
            return { messages: [...data.messages, ...tail], pinned: data.pinned || [], nextCursor: tail.length ? p.nextCursor : data.nextCursor };
          }
          return { messages: data.messages, pinned: data.pinned || [], nextCursor: data.nextCursor };
        });
      } catch (e) {
        if (id !== reqId.current) return;
        if (e.status === 401) return setBoot('auth');
        if (!silent) setListError(e.message);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [view, category, q, deep, showCategories]
  );

  useEffect(() => {
    if (boot !== 'ready' || !mailboxes.length) return;
    setList({ messages: [], pinned: [], nextCursor: null });
    setChecked(new Set());
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, boot, mailboxes.length]);

  function setGroupMode(mode) {
    setGroupModeState(mode);
    localStorage.setItem('zm_group', mode);
    setList((l) => ({ ...l, messages: orderFocus(l.messages, mode) }));
  }

  async function aiTriage() {
    const ids = listRef.current.messages.filter((m) => m._section === 'reply').slice(0, 20).map((m) => m.id);
    if (!ids.length) return;
    setAiBusy(true);
    try {
      const { notes } = await api('/ai/triage', { method: 'POST', body: { ids, force: true } });
      setList((l) => ({ ...l, messages: l.messages.map((m) => (notes[m.id] ? { ...m, aiNote: notes[m.id] } : m)) }));
      notify('AI 已为每封邮件给出行动建议', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setAiBusy(false);
    }
  }

  // ---------- 实时事件 ----------
  const refreshTimer = useRef();
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      loadState();
      loadList({ silent: true });
    }, 600);
  }, [loadState, loadList]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mbRef = useRef(mailboxMap);
  mbRef.current = mailboxMap;

  useRealtimeMail({
    boot,
    notify,
    scheduleRefresh,
    settingsRef,
    mbRef,
    setMailboxes,
    setOutboxVersion,
    openMessage,
    goToday,
  });

  // ---------- 邮件操作 ----------
  function nextAfter(ids) {
    const all = [...listRef.current.pinned, ...listRef.current.messages];
    const idx = all.findIndex((m) => m.id === selectedId);
    const rest = all.filter((m) => !ids.includes(m.id));
    if (idx < 0) return null;
    const after = all.slice(idx + 1).find((m) => !ids.includes(m.id));
    return after || rest[rest.length - 1] || null;
  }

  const doAction = useCallback(
    async (ids, action, extra = {}) => {
      if (!ids.length) return;
      const all = [...listRef.current.pinned, ...listRef.current.messages];
      const fallbackFolder = all.find((m) => m.id === ids[0])?.folder || currentMsg?.folder;
      const origins = Object.fromEntries(ids.map((id) => [id, all.find((m) => m.id === id)?.folder || fallbackFolder]));
      const removes =
        REMOVING.has(action) ||
        ((view.box === 'today' || view.box === 'waiting') && (action === 'done' || action === 'nofollow')) ||
        (action === 'snooze' && view.box !== 'snoozed') ||
        (action === 'unsnooze' && view.box === 'snoozed') ||
        (action === 'unflag' && view.box === 'flagged');

      if (removes) {
        if (ids.includes(selectedId)) {
          const next = nextAfter(ids);
          setSelectedId(next && window.innerWidth > 900 ? next.id : null);
        }
        setList((l) => ({ ...l, messages: l.messages.filter((m) => !ids.includes(m.id)), pinned: l.pinned.filter((m) => !ids.includes(m.id)) }));
        if ((view.box === 'today' || view.box === 'waiting') && (action === 'done' || action === 'nofollow')) {
          const idSet = new Set(ids);
          setFocusData((d) => {
            if (!d) return d;
            const wasReply = (d.reply || []).filter((m) => idSet.has(m.id)).length;
            const wasFollow = (d.followups || []).filter((m) => idSet.has(m.id)).length;
            return {
              ...d,
              reply: (d.reply || []).filter((m) => !idSet.has(m.id)),
              followups: (d.followups || []).filter((m) => !idSet.has(m.id)),
              stats: d.stats
                ? {
                    ...d.stats,
                    needReply: Math.max(0, (d.stats.needReply || 0) - wasReply),
                    followups: Math.max(0, (d.stats.followups || 0) - wasFollow),
                    handledToday: (d.stats.handledToday || 0) + (action === 'done' ? wasReply : 0),
                  }
                : d.stats,
            };
          });
        }
      } else {
        const patch = {
          read: { seen: true }, unread: { seen: false }, flag: { flagged: true }, unflag: { flagged: false }, pin: { pinned: true }, unpin: { pinned: false },
          snooze: { snoozeUntil: extra.until }, unsnooze: { snoozeUntil: null },
          done: { doneAt: Date.now(), awaiting: false, overdue: false }, undone: { doneAt: null },
        }[action];
        if (patch) {
          setList((l) => {
            const map = (m) => (ids.includes(m.id) ? { ...m, ...patch } : m);
            let messages = l.messages.map(map);
            let pinned = l.pinned.map(map);
            if (action === 'pin' && view.box === 'inbox' && !q) {
              pinned = [...pinned, ...messages.filter((m) => ids.includes(m.id))];
              messages = messages.filter((m) => !ids.includes(m.id));
            }
            if (action === 'unpin' && view.box === 'inbox' && !q) {
              messages = [...pinned.filter((m) => ids.includes(m.id)), ...messages].sort((a, b) => b.sortTs - a.sortTs);
              pinned = pinned.filter((m) => !ids.includes(m.id));
            }
            return { ...l, messages, pinned };
          });
        }
        if (action === 'unread' && ids.includes(selectedId)) setSelectedId(null);
      }
      setChecked(new Set());

      try {
        const res = await api('/messages/actions', { method: 'POST', body: { ids, action, ...extra } });
        const n = ids.length > 1 ? `${ids.length} 封邮件` : '';
        const text = ACTION_TEXT[action] && (n ? `${n}${ACTION_TEXT[action]}` : ACTION_TEXT[action]);
        if (action === 'snooze') {
          notify(`将于 ${formatShortDateTime(extra.until)} 重新提醒`, 'info', { label: '撤销', fn: () => doAction(ids, 'unsnooze') }, 6000);
        } else if (UNDO_OF[action]) {
          notify(text, 'info', { label: '撤销', fn: () => doAction(ids, UNDO_OF[action]) }, 6000);
        } else if (res.undoable) {
          notify(text, 'info', { label: '撤销', fn: () => doAction(ids, 'restore', { origins }) }, 7000);
        } else if (text) notify(text);
        if (action === 'restore' || action === 'undone' || action === 'follow') notify('已撤销');
        if (res.followRolled?.length) {
          const f = res.followRolled[0];
          const when = f.nextFollowAt ? formatShortDateTime(f.nextFollowAt) : '';
          notify(
            res.followRolled.length > 1
              ? `已滚动 ${res.followRolled.length} 个客户的下次跟进日`
              : `下次跟进已滚到 ${when}${f.scopeLabel ? ` · ${f.scopeLabel}` : ''}`,
            'success',
            null,
            7000
          );
        }
        loadState();
        if (view.box === 'today' || view.box === 'waiting' || ['restore', 'unsnooze', 'pin', 'unpin'].includes(action)) loadList({ silent: true });
      } catch (e) {
        notify(e.message, 'error');
        loadList({ silent: true });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, q, selectedId, currentMsg, notify, loadState, loadList]
  );


  async function refreshLabels() {
    try {
      const d = await api('/labels');
      setLabels(d.labels || []);
    } catch {
      /* ignore */
    }
  }

  async function createLabelQuick(name, color) {
    const d = await api('/labels', { method: 'POST', body: { name, color } });
    setLabels(d.labels || []);
    notify('标签已创建');
    return d.label;
  }

  function openSavedSearch(ss) {
    if (!ss) return;
    const v = { mailboxId: 'all', box: 'smart', smartId: ss.id };
    setViewState(v);
    localStorage.setItem('zm_view', JSON.stringify(v));
    setSelectedId(null);
    setChecked(new Set());
    setCategory('all');
    setQ(ss.query);
    setDeep(false);
  }

  async function submitSaveSearch({ name, query }) {
    if (saveSearchModal?.mode === 'edit' && saveSearchModal.id) {
      const d = await api(`/saved-searches/${saveSearchModal.id}`, { method: 'PATCH', body: { name, query } });
      setSavedSearches(d.savedSearches || []);
      notify('已更新智能文件夹');
      if (view.box === 'smart' && Number(view.smartId) === Number(saveSearchModal.id)) {
        setQ(query);
      }
    } else {
      const d = await api('/saved-searches', { method: 'POST', body: { name, query, pinned: true } });
      setSavedSearches(d.savedSearches || []);
      notify('已保存到侧栏');
      if (d.savedSearch) openSavedSearch(d.savedSearch);
    }
    setSaveSearchModal(null);
  }

  async function deleteSavedSearch(ss) {
    if (!ss) return;
    if (!confirm(`删除智能文件夹「${ss.name}」？邮件不会被删除。`)) return;
    try {
      const d = await api(`/saved-searches/${ss.id}`, { method: 'DELETE' });
      setSavedSearches(d.savedSearches || []);
      notify('已删除智能文件夹');
      if (view.box === 'smart' && Number(view.smartId) === Number(ss.id)) {
        setView(DEFAULT_VIEW);
      }
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function updateSavedSearchQuery(ss, query) {
    try {
      const d = await api(`/saved-searches/${ss.id}`, { method: 'PATCH', body: { query } });
      setSavedSearches(d.savedSearches || []);
      notify('已更新智能文件夹');
      setQ(query);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function toggleMessageLabels(ids, { add = [], remove = [] } = {}) {
    if (!ids?.length) return;
    try {
      const res = await api('/messages/labels', { method: 'POST', body: { ids, add, remove } });
      const by = res.labelsByMessage || {};
      setList((l) => {
        const map = (m) => (by[m.id] ? { ...m, labels: by[m.id] } : ids.includes(m.id) && (add.length || remove.length) ? { ...m, labels: mergeLocalLabels(m.labels, add, remove, labels) } : m);
        return { ...l, messages: l.messages.map(map), pinned: l.pinned.map(map) };
      });
      setCurrentMsg((cm) => {
        if (!cm || !ids.includes(cm.id)) return cm;
        const next = by[cm.id] || mergeLocalLabels(cm.labels, add, remove, labels);
        return { ...cm, labels: next };
      });
      // 若在标签视图撕掉当前标签，静默刷新列表
      if (view.box === 'label' && remove.map(Number).includes(Number(view.labelId))) {
        loadList({ silent: true });
      }
      refreshLabels();
      if (add.length && !remove.length) notify('已添加标签');
      else if (remove.length && !add.length) notify('已移除标签');
      else notify('标签已更新');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function selectMessage(m) {
    if (isDraftsView || m.specialUse === '\\Drafts') {
      try {
        const d = await api(`/messages/${m.id}?markSeen=0`);
        openCompose('draft', d);
      } catch (e) {
        notify(e.message, 'error');
      }
      return;
    }
    setSelectedId(m.id);
    setCurrentMsg(null);
    if (!m.seen) {
      setList((l) => ({
        ...l,
        messages: l.messages.map((x) => (x.id === m.id ? { ...x, seen: true } : x)),
        pinned: l.pinned.map((x) => (x.id === m.id ? { ...x, seen: true } : x)),
      }));
      setTimeout(loadState, 800);
    }
  }

  async function refresh() {
    setRefreshing(true);
    const targets = view.mailboxId === 'all' ? mailboxes : [mailboxMap[view.mailboxId]].filter(Boolean);
    await Promise.allSettled(targets.map((mb) => api(`/mailboxes/${mb.id}/sync`, { method: 'POST', body: view.box === 'folder' ? { folder: view.folder } : {} })));
    await loadState();
    await loadList({ silent: true });
    setRefreshing(false);
  }

  // ---------- 写信 ----------
  const composeCtx = useMemo(
    () => ({ mailboxes, defaultMailboxId: view.mailboxId !== 'all' && mailboxMap[view.mailboxId] ? view.mailboxId : mailboxes[0]?.id }),
    [mailboxes, mailboxMap, view.mailboxId]
  );

  function pushComposer(initial) {
    setComposers((list) => {
      if (initial.draftId && list.some((c) => c.initial.draftId === initial.draftId)) return list;
      if (list.length >= 3) {
        notify('最多同时打开 3 个写信窗口', 'error');
        return list;
      }
      return [...list, { key: Date.now() + Math.random(), initial }];
    });
  }

  function openCompose(mode = 'new', msg = null, extra = {}) {
    if (mode !== 'new' && !msg) return;
    if (!mailboxes.length) {
      notify(
        user?.role === 'admin' ? '请先绑定邮箱后再写信' : '请先绑定邮箱',
        'info',
        { label: '去绑定', fn: () => setModal({ type: 'add' }) },
        6000
      );
      return;
    }
    pushComposer(buildComposeState(mode, msg, composeCtx, extra));
  }

  async function followUp(m) {
    try {
      const d = await api(`/messages/${m.id}?markSeen=0`);
      const mb = mailboxMap[d.mailboxId];
      const stage = m.deal?.stage || d.deal?.stage;
      openCompose(
        'reply',
        d,
        ai
          ? { aiInstruction: followUpAiForStage(stage) }
          : { body: followUpBodyForStage(m.follow?.to, signatureHtml(mb?.signature), stage) }
      );
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  function handleDealMeta(meta) {
    if (!meta) return;
    if (meta.conflict && meta.deal) {
      notify(`${meta.deal.owner?.name || '同事'} 已认领 ${meta.deal.scopeLabel}，请先沟通再跟进`, 'error', null, 7000);
      return;
    }
    if (meta.claimed && meta.deal) {
      notify(`已自动认领 ${meta.deal.scopeLabel}`, 'success');
    }
    if (meta.stageSuggest && meta.deal?.mine) {
      const sug = meta.stageSuggest;
      const dealId = meta.deal.id;
      notify(`要推进到「${sug.label}」吗？`, 'info', {
        label: '推进',
        fn: async () => {
          try {
            const r = await api(`/deals/${dealId}`, { method: 'PATCH', body: { stage: sug.stage } });
            notify(`阶段已更新为 ${r.deal.stageLabel}`, 'success');
            if (view.box === 'today' || view.box === 'waiting') loadList({ silent: true });
            setDealsVersion((v) => v + 1);
          } catch (e) {
            notify(e.message, 'error');
          }
        },
      }, 10000);
    }
  }

  const removeComposer = (key) => setComposers((list) => list.filter((c) => c.key !== key));

  async function sendMail(payload, files, state, key) {
    if (key) removeComposer(key);
    const undo = Number(settings.undoSeconds ?? 5);
    const sending = payload.sendAt ? null : notify(undo ? `邮件将在 ${undo} 秒后发送` : '正在发送…', 'info', null, 60_000);
    try {
      const res = await api('/send', { method: 'POST', form: toForm({ ...payload, delaySeconds: payload.sendAt ? 0 : undo }, files) });
      if (sending) dismiss(sending);
      const reopen = async () => {
        try {
          await api(`/outbox/${res.outboxId}`, { method: 'DELETE' });
          pushComposer(state);
          notify('已撤销发送');
          loadState();
        } catch (e) {
          notify(e.message, 'error');
        }
      };
      if (res.sent) {
        notify('邮件已发送 ✓', 'success');
      } else if (res.scheduled) {
        notify(`已定时，将于 ${formatShortDateTime(res.sendAt)} 发送`, 'success', { label: '撤销', fn: reopen }, 8000);
      } else {
        const ms = Math.max(1500, res.sendAt - Date.now());
        const id = notify('正在发送…', 'info', { label: '撤销', fn: () => { dismiss(id); reopen(); } }, ms);
      }
      handleDealMeta(res.dealMeta);
      if (payload.replyTo?.id) {
        const rid = payload.replyTo.id;
        setList((l) => ({
          ...l,
          messages:
            view.box === 'today' || view.box === 'waiting'
              ? l.messages.filter((m) => m.id !== rid)
              : l.messages.map((m) => (m.id === rid ? { ...m, answered: true, awaiting: false, overdue: false } : m)),
        }));
        setFocusData((d) => {
          if (!d) return d;
          return {
            ...d,
            reply: (d.reply || []).filter((m) => m.id !== rid),
            stats: d.stats
              ? {
                  ...d.stats,
                  needReply: Math.max(0, (d.stats.needReply || 0) - 1),
                  handledToday: (d.stats.handledToday || 0) + 1,
                }
              : d.stats,
          };
        });
      }
      loadState();
      // 发信后尽快拉 Sent / 刷新 Focus，缩短「已回仍待办」窗口
      setTimeout(() => loadList({ silent: true }), 800);
      setTimeout(() => loadList({ silent: true }), 2800);
      setOutboxVersion((v) => v + 1);
      return true;
    } catch (e) {
      if (sending) dismiss(sending);
      notify(`发送失败：${e.message}`, 'error', null, 8000);
      if (key) pushComposer(state);
      else throw e;
      return false;
    }
  }

  async function saveDraft(payload, files) {
    const res = await api('/drafts', { method: 'POST', form: toForm(payload, files) });
    if (isDraftsView) setTimeout(() => loadList({ silent: true }), 1500);
    return res;
  }

  function closeComposer(key, collected, opts) {
    removeComposer(key);
    if (collected) {
      saveDraft(collected.payload, collected.files)
        .then(() => notify('已保存到草稿箱'))
        .catch((e) => {
          notify(`草稿保存失败：${e.message}`, 'error', { label: '恢复', fn: () => pushComposer(collected.state) }, 10_000);
        });
    }
    if (opts?.discard && opts.draftUid) {
      api('/drafts/discard', { method: 'POST', body: { mailboxId: opts.mailboxId, uid: opts.draftUid } })
        .then(() => isDraftsView && loadList({ silent: true }))
        .catch(() => {});
    }
  }

  function editOutbox(p, item) {
    pushComposer({
      mode: 'new',
      mailboxId: item.mailboxId,
      to: p.to || '',
      cc: p.cc || '',
      bcc: p.bcc || '',
      subject: p.subject || '',
      body: sanitizeHtml(p.html || ''),
      inReplyTo: p.inReplyTo,
      references: p.references,
      replyTo: p.replyTo,
      draftUid: p.draftUid,
      forward: p.forward ? { id: p.forward.id, attachments: (p.forward.indexes || []).map((i) => ({ index: i, filename: `原邮件附件 ${i + 1}`, size: 0 })) } : undefined,
      scheduledFor: item.sendAt,
    });
    loadState();
  }

  // ---------- 账号 ----------
  async function saveSettings(patch) {
    if ('layoutMode' in patch || 'layoutSidebar' in patch || 'layoutList' in patch || 'layoutCustomer' in patch) {
      const mode = normalizeLayoutMode(patch.layoutMode ?? layoutMode);
      if ('layoutMode' in patch) setLayoutModeState(mode);
      const prev = layoutWidthsRef.current;
      const w = widthsFromSettings({
        layoutSidebar: patch.layoutSidebar ?? prev.sidebar,
        layoutList: patch.layoutList ?? prev.list,
        layoutCustomer: patch.layoutCustomer ?? prev.customer,
      });
      if ('layoutSidebar' in patch || 'layoutList' in patch || 'layoutCustomer' in patch) {
        layoutWidthsRef.current = w;
        setLayoutWidths(w);
      }
      saveLayoutLocal(mode, w);
    }
    setUser((u) => ({ ...u, settings: { ...u.settings, ...patch } }));
    try {
      const r = await api('/me/settings', { method: 'PUT', body: patch });
      setUser((u) => ({ ...u, settings: r.settings }));
      if ('replySlaHours' in patch || 'followupDays' in patch) {
        loadState();
        if (view.box === 'today' || view.box === 'waiting') loadList({ silent: true });
      }
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  function persistLayout(nextMode, nextWidths) {
    const mode = normalizeLayoutMode(nextMode);
    const widths = nextWidths || layoutWidthsRef.current;
    saveLayoutLocal(mode, widths);
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      saveSettings({
        layoutMode: mode,
        layoutSidebar: widths.sidebar,
        layoutList: widths.list,
        layoutCustomer: widths.customer,
      });
    }, 450);
  }

  function setLayoutMode(mode) {
    const next = normalizeLayoutMode(mode);
    setLayoutModeState(next);
    persistLayout(next, layoutWidthsRef.current);
  }

  function patchLayoutWidth(key, deltaOrReset) {
    setLayoutWidths((prev) => {
      const lim = LAYOUT_LIMITS[key];
      let nextVal;
      if (deltaOrReset === 'reset') {
        // 销售台列表默认略窄，保证读信区可读
        nextVal = key === 'list' && layoutMode === 'sales' ? LAYOUT_LIMITS.salesListDef : lim.def;
      } else nextVal = prev[key] + deltaOrReset;
      nextVal = Math.min(lim.max, Math.max(lim.min, Math.round(nextVal)));
      const next = { ...prev, [key]: nextVal };
      layoutWidthsRef.current = next;
      saveLayoutLocal(layoutMode, next);
      return next;
    });
  }

  function commitLayoutWidths() {
    persistLayout(layoutMode, layoutWidthsRef.current);
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setMailboxes([]);
    setFolders({});
    setLabels([]);
    setSavedSearches([]);
    setComposers([]);
    setModal(null);
    setList({ messages: [], pinned: [], nextCursor: null });
    setBoot('auth');
  }

  async function onAuthed(u, meta) {
    setUser(u);
    try {
      const d = await api('/me');
      setAi(d.ai);
      applyState(d);
    } catch {
      // ignore
    }
    // 登录后默认进入今日待办作战台
    setView(DEFAULT_VIEW);
    setBoot('ready');
    if (meta?.via === 'recovery') {
      const left = meta.recoveryLeft;
      notify(
        left != null
          ? `已用备用码登录，还剩 ${left} 条。建议尽快在设置中重新生成`
          : '已用备用码登录，建议尽快在设置中重新生成备用码',
        'info',
        null,
        8000
      );
    }
  }

  async function onMailboxBound(res) {
    setModal(null);
    if (res.warning) notify(res.warning, 'error', null, 10_000);
    else notify(`已绑定 ${res.mailbox.email}，正在同步邮件…`, 'success');
    setView(DEFAULT_VIEW);
    await loadState();
  }

  async function newFolder(mb) {
    const name = window.prompt(`在 ${mb.email} 中新建文件夹`, '');
    if (!name?.trim()) return;
    try {
      await api(`/mailboxes/${mb.id}/folders`, { method: 'POST', body: { name: name.trim() } });
      notify('文件夹已创建');
      loadState();
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- 快捷键 ----------
  const keyState = useRef();
  const gPending = useRef(0);
  keyState.current = { allItems, selectedId, selectedItem, currentMsg, modal, composers, checked };
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(el?.tagName) || el?.isContentEditable) return;
      const s = keyState.current;
      if (s.modal) {
        if (e.key === 'Escape') setModal(null);
        return;
      }
      const idx = s.allItems.findIndex((m) => m.id === s.selectedId);
      const step = (d) => {
        const m = s.allItems[Math.min(s.allItems.length - 1, Math.max(0, idx + d))];
        if (m) selectMessage(m);
      };
      const sel = s.selectedId;
      const item = s.selectedItem || s.currentMsg;
      if (gPending.current && Date.now() - gPending.current < 1500) {
        gPending.current = 0;
        const target = { t: 'today', w: 'waiting', i: 'inbox', u: 'unread', s: 'flagged', d: 'deals', a: 'insights' }[e.key];
        if (target) {
          e.preventDefault();
          setView({ mailboxId: 'all', box: target });
          return;
        }
      }
      const global = {
        g: () => (gPending.current = Date.now()),
        c: () => openCompose(),
        j: () => step(1),
        ArrowDown: () => step(1),
        k: () => step(-1),
        ArrowUp: () => step(-1),
        '?': () => setModal({ type: 'help' }),
      };
      const onSelected = {
        r: () => s.currentMsg && openCompose('reply', s.currentMsg),
        a: () => s.currentMsg && openCompose('replyAll', s.currentMsg),
        f: () => s.currentMsg && openCompose('forward', s.currentMsg),
        d: () => {
          const it = s.selectedItem;
          if (it?._section === 'follow') doAction([sel], 'nofollow');
          else doAction([sel], 'done');
        },
        e: () => doAction([sel], 'archive'),
        '#': () => doAction([sel], 'trash'),
        Delete: () => doAction([sel], 'trash'),
        '!': () => doAction([sel], 'spam'),
        b: () => doAction([sel], 'snooze', { until: snoozePresets()[1].at }),
        s: () => item && doAction([sel], item.flagged ? 'unflag' : 'flag'),
        p: () => item && doAction([sel], item.pinned ? 'unpin' : 'pin'),
        u: () => doAction([sel], 'unread'),
        x: () => setChecked((c) => {
          const n = new Set(c);
          n.has(sel) ? n.delete(sel) : n.add(sel);
          return n;
        }),
        Escape: () => setSelectedId(null),
      };
      const fn = global[e.key] || (sel ? onSelected[e.key] : null);
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- 渲染 ----------
  if (boot === 'loading') {
    return (
      <div className="boot">
        <BrandIcon size={56} className="boot-icon" />
      </div>
    );
  }
  if (boot === 'auth' || !user) return <Auth onAuthed={onAuthed} />;

  // 管理员 / 测试账号免绑定：登录即进主界面（管理员可先管团队，稍后再绑邮箱）
  if (!mailboxes.length && user.role !== 'tester' && user.role !== 'admin') {
    return (
      <div className="login-page onboarding">
        <div className="login-hero">
          <HeroBrand />
          <div className="hero-copy">
            <div className="hero-badge">开始使用 · 绑定邮箱</div>
            <h1>你好，{user.name}。<br />先绑定第一个邮箱。</h1>
            <p>绑定后会自动同步最近的邮件。之后可在「设置 → 邮箱账号」继续添加，所有邮箱在同一个收件箱里收发。</p>
          </div>
          <button className="hero-logout" onClick={logout}><LogOut size={14} /> 退出登录</button>
        </div>
        <div className="login-side">
          <MailboxForm title="绑定你的邮箱" onDone={onMailboxBound} />
        </div>
      </div>
    );
  }

  const singleMb = mailboxes.length === 1;
  const activeLabel = view.box === 'label' ? labels.find((l) => Number(l.id) === Number(view.labelId)) : null;
  const activeSavedSearch = view.box === 'smart' ? savedSearches.find((s) => Number(s.id) === Number(view.smartId)) : null;
  const title =
    view.box === 'folder'
      ? folderLabel(currentFolder) || view.folder
      : view.box === 'label'
        ? (activeLabel?.name || '标签')
        : view.box === 'smart'
          ? (activeSavedSearch?.name || '智能文件夹')
          : view.box === 'inbox' && singleMb
            ? '收件箱'
            : SMART_VIEWS[view.box] || '收件箱';
  const subtitle =
    view.box === 'smart'
      ? (activeSavedSearch?.query || '')
      : view.box === 'folder'
        ? (singleMb ? '' : mailboxMap[view.mailboxId]?.email)
        : !singleMb
          ? `${mailboxes.length} 个邮箱`
          : '';
  const checkedRows = allItems.filter((m) => checked.has(m.id));
  const checkedMb = new Set(checkedRows.map((m) => m.mailboxId));
  const moveFolders = checkedMb.size === 1 ? folders[[...checkedMb][0]] : null;
  const unreadInList = allItems.filter((m) => !m.seen).map((m) => m.id);
  const syncBad = mailboxes.filter((m) => m.status === 'error');
  const syncing = mailboxes.filter((m) => m.status === 'syncing' || m.status === 'new');
  const syncAlert = syncBad.length || syncing.length;

  // 销售台：客户栏常驻挂载，未选信显示空态，避免选信时插拔整列跳动
  const showCustomerRail = railAllowed && view.box !== 'scheduled';
  const eff = effectiveWidths(layoutMode, layoutWidths);
  const desktopLayout = viewportW > 900;
  const appStyle = desktopLayout
    ? {
        '--col-sidebar': `${eff.sidebar}px`,
        '--col-list': `${eff.list}px`,
        '--col-customer': `${layoutWidths.customer}px`,
      }
    : undefined;

  return (
    <div
      className={
        'app zm-has-mob'
        + (selectedId ? ' has-selection' : '')
        + (settings.density === 'compact' ? ' compact' : '')
        + (syncAlert ? ' has-sync-strip' : '')
        + (showCustomerRail ? ' has-customer-rail' : '')
        + (layoutMode === 'sales' ? ' layout-sales-desk' : '')
        + ` layout-${layoutMode}`
      }
      style={appStyle}
      data-layout={layoutMode}
    >
      <Sidebar
        user={user}
        mailboxes={mailboxes}
        folders={folders}
        counts={counts}
        view={view}
        onView={setView}
        onCompose={() => openCompose()}
        onDigest={() => setModal({ type: 'digest' })}
        onSettings={(tab, mb) => setModal({ type: 'settings', tab, mb })}
        onAddMailbox={() => setModal({ type: 'add' })}
        onLogout={logout}
        onCommand={() => setPalette(true)}
        onNewFolder={newFolder}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        iconRail={layoutMode === 'focus' && desktopLayout}
        layoutMode={layoutMode}
        onLayoutMode={setLayoutMode}
        salesRailTip={layoutMode === 'sales' && viewportW < LAYOUT_LIMITS.salesRailMinViewport}
        labels={labels}
        onCreateLabel={() => setModal({ type: 'settings', tab: 'labels' })}
        savedSearches={savedSearches}
        onOpenSavedSearch={openSavedSearch}
        onCreateSavedSearch={() => setSaveSearchModal({ mode: 'create', name: '', query: q || '' })}
        onEditSavedSearch={(s) => setSaveSearchModal({ mode: 'edit', id: s.id, name: s.name, query: s.query })}
        onDeleteSavedSearch={deleteSavedSearch}
      />
      {sidebarOpen && <div className="sidebar-mask" onClick={() => setSidebarOpen(false)} />}

      {desktopLayout && layoutMode !== 'focus' && (
        <ColumnSplitter
          label="拖拽调整 · 双击恢复默认"
          style={{ left: eff.sidebar }}
          onDrag={(d) => {
            if (d === 'reset') patchLayoutWidth('sidebar', 'reset');
            else patchLayoutWidth('sidebar', d);
          }}
          onDragEnd={commitLayoutWidths}
        />
      )}
      {desktopLayout && (
        <ColumnSplitter
          label="拖拽调整 · 双击恢复默认"
          style={{ left: eff.sidebar + eff.list }}
          onDrag={(d) => {
            if (d === 'reset') patchLayoutWidth('list', 'reset');
            else patchLayoutWidth('list', d);
          }}
          onDragEnd={commitLayoutWidths}
        />
      )}
      {desktopLayout && showCustomerRail && (
        <ColumnSplitter
          label="拖拽调整 · 双击恢复默认"
          style={{ left: `calc(100% - ${layoutWidths.customer}px)` }}
          onDrag={(d) => {
            // 拖客户栏左边：向右变窄（delta 为正 → 宽度减小）
            if (d === 'reset') patchLayoutWidth('customer', 'reset');
            else patchLayoutWidth('customer', -d);
          }}
          onDragEnd={commitLayoutWidths}
        />
      )}

      {syncAlert ? (
        <div className={'mb-sync-strip' + (syncBad.length ? ' err' : '')} role="status">
          {syncBad.length ? (
            <>
              <AlertCircle size={14} />
              <span title={syncBad[0]?.lastError || ''}>
                {syncBad.length === 1
                  ? `${syncBad[0].email} 同步失败${syncBad[0].lastError ? `：${String(syncBad[0].lastError).slice(0, 48)}` : ''}`
                  : `${syncBad.length} 个邮箱同步失败`}
              </span>
              <button type="button" className="mb-sync-link" onClick={() => refresh()} disabled={refreshing}>
                {refreshing ? '同步中…' : '重试同步'}
              </button>
              <button type="button" className="mb-sync-link" onClick={() => setModal({ type: 'settings', tab: 'mailboxes', mb: syncBad[0]?.id })}>去设置</button>
            </>
          ) : (
            <>
              <RefreshCw size={14} className="spin" />
              <span>正在同步 {syncing.length} 个邮箱…</span>
            </>
          )}
        </div>
      ) : null}

      {user.role === 'admin' && !mailboxes.length && ['today', 'waiting', 'inbox', 'unread', 'flagged', 'sent', 'deals', 'team', 'insights'].includes(view.box) ? (
        <AdminEmpty
          user={user}
          onAddMailbox={() => setModal({ type: 'add' })}
          onOpenTeam={() => setModal({ type: 'settings', tab: 'team' })}
          onOpenSettings={() => setModal({ type: 'settings', tab: 'preferences' })}
        />
      ) : view.box === 'scheduled' ? (
        <Outbox
          mailboxMap={mailboxMap}
          onMenu={() => setSidebarOpen(true)}
          onEdit={editOutbox}
          notify={notify}
          version={outboxVersion}
          onChanged={loadState}
        />
      ) : view.box === 'today' ? (
        <Focus
          user={user}
          data={focusData}
          messages={list.messages}
          loading={loading}
          error={listError}
          selectedId={selectedId}
          onSelect={selectMessage}
          onAction={doAction}
          mailboxMap={mailboxMap}
          onRefresh={refresh}
          refreshing={refreshing}
          aiEnabled={ai}
          onAiTriage={aiTriage}
          aiBusy={aiBusy}
          groupMode={groupMode}
          setGroupMode={setGroupMode}
          onFollowUp={followUp}
          onMenu={() => setSidebarOpen(true)}
          checked={checked}
          setChecked={setChecked}
          salesDensity={layoutMode === 'sales'}
          notify={notify}
        />
      ) : view.box === 'waiting' ? (
        <Waiting
          data={focusData}
          messages={list.messages}
          loading={loading}
          error={listError}
          selectedId={selectedId}
          onSelect={selectMessage}
          onAction={doAction}
          mailboxMap={mailboxMap}
          onRefresh={refresh}
          refreshing={refreshing}
          onFollowUp={followUp}
          onMenu={() => setSidebarOpen(true)}
          tab={waitingTab}
          setTab={setWaitingTab}
        />
      ) : view.box === 'team' ? (
        <TeamQueue
          onMenu={() => setSidebarOpen(true)}
          notify={notify}
          onOpenMessage={(id) => openMessage(id, { box: 'inbox' })}
        />
      ) : view.box === 'deals' ? (
        <Deals
          key={dealsVersion}
          onMenu={() => setSidebarOpen(true)}
          notify={notify}
          onOpenDeal={(d) => {
            if (d.lastAddress) openCustomer(d.lastAddress, { name: d.scopeLabel, address: d.lastAddress });
          }}
        />
      ) : view.box === 'insights' ? (
        <Insights onMenu={() => setSidebarOpen(true)} isAdmin={user.role === 'admin'} />
      ) : (
        <MailList
          title={title}
          subtitle={subtitle}
          view={{ ...view, special }}
          mailboxMap={mailboxMap}
          messages={list.messages}
          pinned={list.pinned}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={!!list.nextCursor}
          onLoadMore={() => loadList({ append: true })}
          selectedId={selectedId}
          onSelect={selectMessage}
          checked={checked}
          setChecked={setChecked}
          category={category}
          setCategory={setCategory}
          showCategories={showCategories}
          q={q}
          deep={deep}
          onSearch={(nq, d) => {
            if (!nq && view.box === 'smart') {
              setView({ mailboxId: 'all', box: 'inbox' });
              return;
            }
            setQ(nq);
            setDeep(!!d && !!nq);
            setSelectedId(null);
          }}
          onRefresh={refresh}
          refreshing={refreshing}
          onAction={doAction}
          moveFolders={moveFolders}
          onMenu={() => setSidebarOpen(true)}
          error={listError}
          compact={settings.density === 'compact'}
          onMarkAllRead={
            unreadInList.length && ['inbox', 'unread', 'folder', 'label'].includes(view.box)
              ? () => doAction(unreadInList, 'read')
              : null
          }
          labels={labels}
          onToggleLabels={toggleMessageLabels}
          onCreateLabel={async (n) => { await createLabelQuick(n); }}
          activeSavedSearch={activeSavedSearch}
          onSaveSearch={(query) => setSaveSearchModal({ mode: 'create', name: '', query })}
          onUpdateSavedSearch={updateSavedSearchQuery}
        />
      )}

      {view.box !== 'scheduled' && (
        <Reader
          id={selectedId}
          listItem={selectedItem}
          settings={settings}
          aiEnabled={ai}
          dark={dark}
          mailboxMap={mailboxMap}
          folders={folders}
          composeCtx={composeCtx}
          onCompose={openCompose}
          onAction={doAction}
          onSend={(payload, files, state) => sendMail(payload, files, state)}
          onBack={() => setSelectedId(null)}
          onFollowUp={followUp}
          notify={notify}
          onOpenCustomer={(addr, detail) => {
            const sender = detail?.sender ? { ...detail.sender, address: addr || detail.sender.address || detail.from?.address } : null;
            setCustomerCtx({
              address: addr || sender?.address || detail?.from?.address,
              sender,
              slaHours: selectedItem?.priority?.slaHours,
            });
            if (!railAllowed) setCustomerOpen(true);
          }}
          onOpenSettings={(tab) => setModal({ type: 'settings', tab: tab || 'preferences' })}
          labels={labels}
          onToggleLabels={toggleMessageLabels}
          onCreateLabel={async (n) => { await createLabelQuick(n); }}
          onAiNote={(mid, note) => {
            setList((l) => ({
              ...l,
              messages: l.messages.map((m) => (m.id === mid ? { ...m, aiNote: note } : m)),
              pinned: (l.pinned || []).map((m) => (m.id === mid ? { ...m, aiNote: note } : m)),
            }));
          }}
          onLoaded={(m) => {
            setCurrentMsg(m);
            if (!m.seen) loadState();
            if (m?.sender || m?.from) {
              setCustomerCtx((prev) => ({
                address: m.from?.address || prev?.address,
                sender: m.sender ? { ...m.sender, address: m.from?.address } : prev?.sender,
                slaHours: selectedItem?.priority?.slaHours ?? prev?.slaHours,
              }));
            }
          }}
        />
      )}


      {showCustomerRail && (
        <aside className="customer-rail" aria-label="客户栏">
          <CustomerPanel
            mode="rail"
            address={selectedId ? (customerCtx?.address || currentMsg?.from?.address || selectedItem?.from?.address) : null}
            sender={selectedId ? (customerCtx?.sender || (currentMsg?.sender ? { ...currentMsg.sender, address: currentMsg.from?.address } : null)) : null}
            slaHours={selectedId ? (customerCtx?.slaHours ?? selectedItem?.priority?.slaHours) : null}
            listItem={selectedId ? selectedItem : null}
            onRule={setCustomerRule}
            onOpenThread={(mid) => setSelectedId(mid)}
            onOpenContacts={() => setModal({ type: 'settings', tab: 'contacts' })}
          />
        </aside>
      )}

      {!showCustomerRail && customerOpen && (
        <>
          <div className="customer-drawer-mask" onClick={() => setCustomerOpen(false)} />
          <div className="customer-drawer" role="dialog" aria-modal="true" aria-label="客户">
            <CustomerPanel
              mode="drawer"
              address={customerCtx?.address || currentMsg?.from?.address}
              sender={customerCtx?.sender || (currentMsg?.sender ? { ...currentMsg.sender, address: currentMsg.from?.address } : null)}
              slaHours={customerCtx?.slaHours ?? selectedItem?.priority?.slaHours}
              listItem={selectedItem}
              onRule={setCustomerRule}
              onOpenThread={(mid) => { setCustomerOpen(false); setSelectedId(mid); }}
              onClose={() => setCustomerOpen(false)}
              onOpenContacts={() => { setCustomerOpen(false); setModal({ type: 'settings', tab: 'contacts' }); }}
            />
          </div>
        </>
      )}

      <div className="composer-dock">
        {composers.map((c, i) => (
          <Composer
            key={c.key}
            initial={c.initial}
            mailboxes={mailboxes}
            aiEnabled={ai}
            stacked={composers.length > 1 && i < composers.length - 1}
            onSend={(payload, files, state) => sendMail(payload, files, state, c.key)}
            onSaveDraft={saveDraft}
            onClose={(collected, opts) => closeComposer(c.key, collected, opts)}
            notify={notify}
            glossary={settings.glossary}
            onOpenSettings={(tab) => setModal({ type: 'settings', tab: tab || 'preferences' })}
          />
        ))}
      </div>

      {modal?.type === 'digest' && (
        <Digest
          aiEnabled={ai}
          mailboxMap={mailboxMap}
          onClose={() => setModal(null)}
          onOpen={(m) => {
            setModal(null);
            setSelectedId(m.id);
          }}
        />
      )}
      {modal?.type === 'settings' && (
        <Settings
          user={user}
          mailboxes={mailboxes}
          tab={modal.tab}
          focusMailbox={modal.mb}
          onClose={() => setModal(null)}
          notify={notify}
          onUserChange={setUser}
          onSettings={saveSettings}
          onMailboxesChanged={loadState}
          onAddMailbox={() => setModal({ type: 'add' })}
          onLogout={logout}
          aiEnabled={ai}
          onLabelsChanged={(list) => setLabels(list || [])}
        />
      )}
      {modal?.type === 'add' && (
        <div className="modal-mask" onClick={() => setModal(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <MailboxForm onDone={onMailboxBound} onCancel={() => setModal(null)} />
          </div>
        </div>
      )}
      {modal?.type === 'help' && (
        <div className="modal-mask" onClick={() => setModal(null)}>
          <div className="modal help" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b><Keyboard size={16} /> 键盘快捷键</b>
              <button className="icon-btn" onClick={() => setModal(null)}><X size={18} /></button>
            </div>
            <div className="modal-body shortcuts">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}><kbd>{k}</kbd><span>{v}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {saveSearchModal && (
        <SaveSearchModal
          open={!!saveSearchModal}
          mode={saveSearchModal.mode}
          initialName={saveSearchModal.name}
          initialQuery={saveSearchModal.query}
          presets={searchPresets.length ? searchPresets : [
            { name: '有附件', query: 'has:attachment' },
            { name: 'VIP 未读', query: 'is:vip is:unread' },
            { name: '未读询盘', query: 'is:unread subject:询价' },
            { name: '待开票标签', query: 'label:待开票' },
          ]}
          onClose={() => setSaveSearchModal(null)}
          onSubmit={submitSaveSearch}
        />
      )}

      <Palette
        open={palette}
        messages={allItems}
        hasSelection={!!selectedId}
        onClose={() => setPalette(false)}
        onOpen={(m) => { setPalette(false); selectMessage(m); }}
        onGo={(box) => { setPalette(false); setView({ mailboxId: 'all', box }); }}
        onCompose={() => { setPalette(false); openCompose(); }}
        onReply={() => { setPalette(false); currentMsg && openCompose('reply', currentMsg); }}
        onDone={() => { setPalette(false); selectedId && doAction([selectedId], selectedItem?._section === 'follow' ? 'nofollow' : 'done'); }}
        onSnooze={() => { setPalette(false); selectedId && doAction([selectedId], 'snooze', { until: snoozePresets()[1].at }); }}
      />

      <nav className="zm-mob-nav" aria-label="移动主导航">
        <button
          type="button"
          className={view.box === 'today' ? 'on' : ''}
          aria-label="今日待办"
          onClick={() => { setSelectedId(null); setView({ mailboxId: 'all', box: 'today' }); setSidebarOpen(false); }}
        >
          <ListTodo size={20} strokeWidth={1.75} />
          <span>待办</span>
        </button>
        <button
          type="button"
          className={view.box === 'inbox' ? 'on' : ''}
          aria-label="收件箱"
          onClick={() => { setSelectedId(null); setView({ mailboxId: 'all', box: 'inbox' }); setSidebarOpen(false); }}
        >
          <Inbox size={20} strokeWidth={1.75} />
          <span>收件</span>
        </button>
        <button
          type="button"
          className={view.box === 'waiting' ? 'on' : ''}
          aria-label="等待"
          onClick={() => { setSelectedId(null); setView({ mailboxId: 'all', box: 'waiting' }); setSidebarOpen(false); }}
        >
          <Hourglass size={20} strokeWidth={1.75} />
          <span>等待</span>
        </button>
        <button
          type="button"
          className="zm-mob-compose"
          aria-label="写邮件"
          onClick={() => { setSidebarOpen(false); openCompose(); }}
        >
          <PenSquare size={20} strokeWidth={1.75} />
          <span>写信</span>
        </button>
        <button
          type="button"
          aria-label="更多"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu size={20} strokeWidth={1.75} />
          <span>更多</span>
        </button>
      </nav>

      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.type} role="status">
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  dismiss(t.id);
                  t.action.fn();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-x" aria-label="关闭通知" onClick={() => dismiss(t.id)}><X size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
