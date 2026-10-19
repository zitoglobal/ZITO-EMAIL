import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { displayName } from '../utils.js';

/**
 * SSE：同步 / 新邮件 / 逾期提醒 / 发件箱 / 标签·联系人。
 * openMessage(id, { box }) 用于通知点达（不丢失选中）。
 */
export function useRealtimeMail({
  boot,
  notify,
  scheduleRefresh,
  settingsRef,
  mbRef,
  setMailboxes,
  setOutboxVersion,
  setLabels,
  setSavedSearches,
  openMessage,
  goToday,
  goBox,
}) {
  const scheduleRef = useRef(scheduleRefresh);
  scheduleRef.current = scheduleRefresh;
  const openRef = useRef(openMessage);
  openRef.current = openMessage;
  const goTodayRef = useRef(goToday);
  goTodayRef.current = goToday;
  const goBoxRef = useRef(goBox);
  goBoxRef.current = goBox;
  const setLabelsRef = useRef(setLabels);
  setLabelsRef.current = setLabels;
  const setSavedRef = useRef(setSavedSearches);
  setSavedRef.current = setSavedSearches;

  useEffect(() => {
    if (boot !== 'ready') return;
    const es = new EventSource('/api/events');
    let fastTimer;
    const parse = (e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return {};
      }
    };

    const bumpCollab = (detail) => {
      window.dispatchEvent(new CustomEvent('zm-collab', { detail: detail || {} }));
    };

    es.addEventListener('sync', (e) => {
      const d = parse(e);
      // Sent / 发信本地同步：更快刷新，稳住今日待办与等待
      if (d?.deal) window.dispatchEvent(new CustomEvent('zm-deal', { detail: d }));
      if (d?.deal || d?.sent) bumpCollab(d);
      if (d?.sent || d?.deal) {
        clearTimeout(fastTimer);
        fastTimer = setTimeout(() => scheduleRef.current(), 200);
      } else {
        scheduleRef.current();
      }
    });
    es.addEventListener('mailbox', (e) => {
      const d = parse(e);
      setMailboxes((list) =>
        list.map((m) =>
          m.id === d.id
            ? { ...m, status: d.status, lastError: d.error || null, lastSync: d.status === 'ok' ? Date.now() : m.lastSync }
            : m
        )
      );
      if (d.status === 'ok' || d.status === 'error') scheduleRef.current();
    });
    es.addEventListener('new', (e) => {
      const d = parse(e);
      const mb = mbRef.current[d.mailboxId];
      const first = d.items?.[0];
      const important = !d.snooze && first?.important;
      const text = d.snooze
        ? `稍后提醒：${first?.subject || ''}`
        : important
          ? `${first.label}来信 · ${displayName(first.from)}：${first.subject || '(无主题)'}${d.count > 1 ? `（另有 ${d.count - 1} 封）` : ''}`
          : d.count > 1
            ? `${mb?.email || ''} 收到 ${d.count} 封新邮件`
            : `${displayName(first?.from)}：${first?.subject || '(无主题)'}`;
      notify(
        text,
        important ? 'important' : 'info',
        first ? { label: '查看', fn: () => openRef.current(first.id, { box: important ? 'today' : 'inbox' }) } : null,
        important ? 10_000 : 6000
      );
      if (settingsRef.current.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(d.snooze ? '稍后提醒' : important ? `重要 · ${first.label}来信` : `新邮件 · ${mb?.email || ''}`, {
          body: text,
          tag: 'zm-' + d.mailboxId,
          icon: '/favicon-180.png',
        });
        n.onclick = () => {
          window.focus();
          if (first) openRef.current(first.id, { box: important ? 'today' : 'inbox' });
        };
      }
      // 新来信可能消掉「等待对方」或抬高今日待办 / 公海：快刷
      bumpCollab({ new: true, important });
      clearTimeout(fastTimer);
      fastTimer = setTimeout(() => scheduleRef.current(), important ? 150 : 350);
    });
    es.addEventListener('remind', (e) => {
      const d = parse(e);
      const first = d.items?.[0];
      const escalate = !!d.escalate;
      const text =
        d.count > 1
          ? `${escalate ? '再次提醒：' : ''}有 ${d.count} 封客户邮件已超过回复时限，最早的来自 ${displayName(first?.from)}`
          : `${escalate ? '再次提醒 · ' : ''}${displayName(first?.from)} 的邮件已超过回复时限：${first?.subject || ''}`;
      notify(
        text,
        'important',
        {
          label: first ? '打开这封' : '去处理',
          fn: () => (first ? openRef.current(first.id, { box: 'today' }) : goTodayRef.current()),
        },
        15_000
      );
      if (settingsRef.current.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(escalate ? '超时升级提醒' : '客户邮件待回复', {
          body: text,
          tag: 'zm-remind',
          icon: '/favicon-180.png',
        });
        n.onclick = () => {
          window.focus();
          if (first) openRef.current(first.id, { box: 'today' });
          else goTodayRef.current();
        };
      }
      scheduleRef.current();
    });
    es.addEventListener('remind-queue', (e) => {
      const d = parse(e);
      const text = `公海有 ${d.count || 0} 条超时未认领${d.vip ? `（含 ${d.vip} VIP）` : ''}，最早已等 ${d.oldestHours || 0}h`;
      notify(
        text,
        'important',
        { label: '去公海', fn: () => (goBoxRef.current ? goBoxRef.current('team') : goTodayRef.current?.()) },
        15_000
      );
      if (settingsRef.current.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('团队公海待认领', { body: text, tag: 'zm-team-queue', icon: '/favicon-180.png' });
        n.onclick = () => {
          window.focus();
          goBoxRef.current?.('team');
        };
      }
      bumpCollab({ queue: true, ...d });
    });
    es.addEventListener('deal-assigned', (e) => {
      const d = parse(e);
      notify(
        `${d.from || '管理员'} 把 ${d.scopeLabel || '客户'} 指派给你`,
        'important',
        { label: '去今日待办', fn: () => goTodayRef.current?.() },
        12_000
      );
      window.dispatchEvent(new CustomEvent('zm-deal', { detail: d }));
      bumpCollab({ assigned: true, ...d });
    });
    es.addEventListener('deal-claimed-other', (e) => {
      const d = parse(e);
      notify(
        `${d.from || '同事'} 已认领 ${d.scopeLabel || '客户'}（来自你的邮箱）`,
        'important',
        { label: '看公海', fn: () => (goBoxRef.current ? goBoxRef.current('team') : goTodayRef.current?.()) },
        12_000
      );
      window.dispatchEvent(new CustomEvent('zm-deal', { detail: d }));
      bumpCollab({ claimedOther: true, ...d });
    });
    es.addEventListener('outbox', (e) => {
      const d = parse(e);
      if (d.status === 'sent') notify('邮件已发送 ✓', 'success');
      if (d.status === 'failed') {
        notify(
          `发送失败：${d.error || '未知错误'}`,
          'error',
          { label: '打开发送队列', fn: () => goBoxRef.current?.('scheduled') },
          12_000
        );
      }
      if (d.status === 'retry') {
        notify(`发送暂时失败，将自动重试（${d.tries}/2）：${d.error || ''}`, 'info', null, 8_000);
      }
      setOutboxVersion((v) => v + 1);
      scheduleRef.current();
    });
    es.addEventListener('presence', (e) => {
      const d = parse(e);
      if (d?.messageId != null) {
        window.dispatchEvent(new CustomEvent('zm-presence', { detail: d }));
      }
    });
    es.addEventListener('labels', () => {
      api('/labels')
        .then((d) => setLabelsRef.current?.(d.labels || []))
        .catch(() => {});
    });
    es.addEventListener('contacts', (e) => {
      window.dispatchEvent(new CustomEvent('zm-contacts', { detail: parse(e) }));
    });
    es.addEventListener('saved-searches', () => {
      api('/saved-searches')
        .then((d) => setSavedRef.current?.(d.savedSearches || []))
        .catch(() => {});
    });
    return () => {
      clearTimeout(fastTimer);
      es.close();
    };
  }, [boot, notify, setMailboxes, setOutboxVersion, settingsRef, mbRef]);
}
