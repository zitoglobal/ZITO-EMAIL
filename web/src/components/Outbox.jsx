import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Menu, Send, Pencil, X, Clock, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { formatShortDateTime, relativeTime, schedulePresets } from '../utils.js';
import TimeMenu from './TimeMenu.jsx';

export default function Outbox({ mailboxMap, onMenu, onEdit, notify, version, onChanged }) {
  const [items, setItems] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api('/outbox')
      .then((r) => setItems(r.items))
      .catch((e) => notify(e.message, 'error'));
  }, [notify]);

  useEffect(() => {
    load();
  }, [load, version]);

  async function run(id, fn, ok) {
    setBusy(id);
    try {
      const r = await fn();
      if (ok) notify(ok);
      load();
      onChanged();
      return r;
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const reschedule = (id, sendAt) => run(id, () => api(`/outbox/${id}/reschedule`, { method: 'POST', body: { sendAt } }), sendAt <= Date.now() ? '正在发送…' : '已修改发送时间');

  async function edit(item) {
    const r = await run(item.id, () => api(`/outbox/${item.id}`, { method: 'DELETE' }));
    if (r?.payload) onEdit(r.payload, item);
  }

  return (
    <section className="list-pane wide">
      <header className="list-head">
        <div className="list-title-row">
          <button className="icon-btn mobile-only" onClick={onMenu}><Menu size={18} /></button>
          <div className="list-title">
            <h2>定时发送</h2>
            <small>到点后由服务器自动发出，关闭浏览器也不影响</small>
          </div>
          <button className="icon-btn" onClick={load} title="刷新"><RefreshCw size={16} /></button>
        </div>
      </header>
      <div className="list-body">
        {!items && <div className="reader-loading"><Loader2 size={18} className="spin" /> 加载中…</div>}
        {items?.length === 0 && (
          <div className="empty">
            <CalendarClock size={42} strokeWidth={1.2} />
            <p>没有待发送的邮件</p>
            <small>写信时点击发送按钮旁的箭头即可定时发送</small>
          </div>
        )}
        {items?.map((it) => {
          const mb = mailboxMap[it.mailboxId];
          return (
            <div key={it.id} className={'outbox-row' + (it.status === 'failed' ? ' failed' : '')}>
              {mb && <span className="mb-stripe" style={{ background: mb.color }} />}
              <div className="ob-main">
                <div className="ob-line1">
                  <b>{it.subject || '(无主题)'}</b>
                  <span className={'ob-time' + (it.status === 'failed' ? ' err' : '')}>
                    {it.status === 'failed' ? <AlertCircle size={12} /> : it.status === 'sending' ? <Loader2 size={12} className="spin" /> : <Clock size={12} />}
                    {it.status === 'failed'
                      ? '发送失败'
                      : it.status === 'sending'
                        ? '发送中'
                        : it.tries > 0
                          ? `自动重试中 · ${formatShortDateTime(it.sendAt)}`
                          : `${formatShortDateTime(it.sendAt)}（${relativeTime(it.sendAt)}）`}
                  </span>
                </div>
                <div className="ob-line2">致：{it.to || '—'}{mb && <span className="muted"> · 由 {mb.email} 发出</span>}</div>
                {it.error && <div className="ob-err">{it.error}</div>}
                {it.status === 'failed' && /中断|已发送/.test(it.error || '') && (
                  <div className="ob-err muted">请先到「已发送」确认是否已发出，避免重复投递后再点重试。</div>
                )}
              </div>
              {it.status !== 'sending' && (
                <div className="ob-actions">
                  <button className="btn-ghost sm" disabled={busy === it.id} onClick={() => reschedule(it.id, Date.now())}>
                    <Send size={13} /> {it.status === 'failed' ? '重试' : '立即发送'}
                  </button>
                  <div className="move-wrap">
                    <button className="btn-ghost sm" onClick={() => setMenu(menu === it.id ? null : it.id)}><Clock size={13} /> 改时间</button>
                    {menu === it.id && (
                      <TimeMenu
                        title="修改发送时间"
                        presets={schedulePresets()}
                        className="right"
                        onClose={() => setMenu(null)}
                        onPick={(t) => { setMenu(null); reschedule(it.id, t); }}
                      />
                    )}
                  </div>
                  <button className="btn-ghost sm" disabled={busy === it.id} onClick={() => edit(it)}><Pencil size={13} /> 编辑</button>
                  <button
                    className="btn-ghost sm danger"
                    disabled={busy === it.id}
                    onClick={() => window.confirm('取消发送并删除这封邮件？') && run(it.id, () => api(`/outbox/${it.id}`, { method: 'DELETE' }), '已取消发送')}
                  >
                    <X size={13} /> 取消
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
