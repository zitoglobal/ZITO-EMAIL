import React, { useEffect, useState } from 'react';
import { Hand, Unlock, Loader2, GitBranch, History, StickyNote, CalendarClock, Split } from 'lucide-react';
import { api, qs } from '../api.js';
import { formatShortDateTime } from '../utils.js';

const ACTION_LABEL = {
  claim: '认领',
  release: '释放',
  stage: '改阶段',
  takeover: '接管',
  assign: '指派',
  follow: '跟进日',
  split: '拆到个人',
};

/**
 * 团队认领 + 业务阶段条（邮箱内销售台）
 */
export default function DealBar({
  deal,
  scope,
  scopes,
  stages = [],
  address,
  threadId,
  messageId,
  canSplitDeal,
  canClaimPerson,
  notify,
  onChange,
}) {
  const [busy, setBusy] = useState('');
  const [events, setEvents] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const hasCompany = !!(scopes?.company || scope?.kind === 'company' || deal?.scopeKind === 'company');
  const visible = !!(scope || deal || scopes?.person);

  useEffect(() => {
    setNoteDraft(deal?.note || '');
    setEditingNote(false);
  }, [deal?.id, deal?.note]);

  useEffect(() => {
    if (!visible) {
      setEvents([]);
      return undefined;
    }
    let cancelled = false;
    const params = deal?.id
      ? { dealId: deal.id, limit: 8 }
      : address
        ? { address, limit: 8 }
        : null;
    if (!params) {
      setEvents([]);
      return undefined;
    }
    api('/deals/events' + qs(params))
      .then((d) => {
        if (!cancelled) setEvents(d.events || []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, deal?.id, address, deal?.stage, deal?.claimedAt]);

  if (!visible) return null;

  async function claim(force = false, scopeKind) {
    setBusy(scopeKind === 'address' ? 'claim-person' : 'claim');
    try {
      const d = await api('/deals/claim', {
        method: 'POST',
        body: { address, threadId, messageId: messageId || undefined, force, scopeKind },
      });
      onChange?.(d.deal);
      const label =
        scopeKind === 'address'
          ? `已认领联系人 ${d.deal.scopeLabel}`
          : force
            ? '已接管认领'
            : `已认领 ${d.deal.scopeLabel}`;
      notify(label, 'success');
    } catch (e) {
      if (e.status === 409 && e.deal) {
        onChange?.(e.deal);
        notify(e.message, 'error');
      } else notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function split() {
    if (!deal?.id) return;
    if (
      !window.confirm(
        `将「${deal.scopeLabel}」拆到个人「${address}」？\n公司域认领会释放，同事可跟同域其它采购。`
      )
    ) {
      return;
    }
    setBusy('split');
    try {
      const d = await api(`/deals/${deal.id}/split`, { method: 'POST', body: {} });
      onChange?.(d.deal);
      notify(`已拆到个人 ${d.deal.scopeLabel}`, 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function release() {
    if (!deal?.id) return;
    if (!window.confirm(`确定释放「${deal.scopeLabel}」的认领？同事将可以认领。`)) return;
    setBusy('release');
    try {
      await api(`/deals/${deal.id}/release`, { method: 'POST', body: {} });
      onChange?.(null);
      notify('已释放认领');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function setStage(stage) {
    if (!deal?.id || stage === deal.stage) return;
    setBusy('stage');
    try {
      const d = await api(`/deals/${deal.id}`, {
        method: 'PATCH',
        body: { stage, messageId: messageId || undefined },
      });
      onChange?.(d.deal);
      const tag = d.stageLabel?.name ? `，并贴标签「${d.stageLabel.name}」` : '';
      notify(`阶段已更新为 ${d.deal.stageLabel}${tag}`);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function saveNote() {
    if (!deal?.id) return;
    const note = noteDraft.trim().slice(0, 200);
    if (note === (deal.note || '')) {
      setEditingNote(false);
      return;
    }
    setBusy('note');
    try {
      const d = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { note } });
      onChange?.(d.deal);
      setEditingNote(false);
      notify(note ? '备注已保存' : '备注已清空');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function setFollowAt(ts) {
    if (!deal?.id) return;
    setBusy('follow');
    try {
      const d = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { nextFollowAt: ts } });
      onChange?.(d.deal);
      notify(ts ? `下次跟进：${formatShortDateTime(ts)}` : '已清除跟进日');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const followPresets = () => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    const day = (n) => {
      const x = new Date(d);
      x.setDate(x.getDate() + n);
      return x.getTime();
    };
    return [
      { label: '明天', at: day(1) },
      { label: '3 天', at: day(3) },
      { label: '一周', at: day(7) },
    ];
  };

  const list = stages.length ? stages : deal ? [{ id: deal.stage, label: deal.stageLabel, color: deal.stageColor }] : [];
  const canEdit = deal && (deal.mine || deal.canRelease);
  const showSplit = !!(canSplitDeal || (deal?.mine && deal.scopeKind === 'company'));
  const showClaimPerson =
    !!(canClaimPerson || (hasCompany && (!deal || (deal && !deal.mine && deal.scopeKind === 'company')))) &&
    !!address;

  return (
    <div className={'deal-bar' + (deal && !deal.mine ? ' taken' : '') + (deal?.mine ? ' mine' : '')}>
      <div className="deal-bar-main">
        <GitBranch size={14} />
        <div className="deal-bar-text">
          {!deal && (
            <>
              <b>未认领</b>
              <span>
                {hasCompany
                  ? `默认可认领公司 ${scopes?.company?.label || scope?.label}；同域多采购可改为「仅此人」`
                  : `客户 ${scope?.label || address} — 认领后同事可见归属，减少撞单报价`}
              </span>
            </>
          )}
          {deal?.mine && (
            <>
              <b>
                我已认领 · {deal.scopeLabel}
                {deal.scopeKind === 'address' ? '（个人）' : deal.scopeKind === 'company' ? '（公司）' : ''}
              </b>
              <span>
                当前阶段：{deal.stageLabel}
                {deal.note && !editingNote ? ` · ${deal.note}` : ''}
                {deal.nextFollowAt ? ` · 跟进 ${formatShortDateTime(deal.nextFollowAt)}` : ''}
              </span>
            </>
          )}
          {deal && !deal.mine && (
            <>
              <b>
                {deal.owner.name} 已认领 · {deal.scopeLabel}
                {deal.scopeKind === 'company' ? '（公司）' : ''}
              </b>
              <span>
                阶段 {deal.stageLabel}
                {deal.note ? ` · ${deal.note}` : ''}
                {deal.scopeKind === 'company'
                  ? ' — 可「仅认领此人」跟当前采购，不抢公司锁'
                  : ' — 请先确认再回复，避免重复报价'}
              </span>
            </>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="deal-follow-row" title="客户级下次跟进日">
          <CalendarClock size={12} />
          {followPresets().map((p) => (
            <button key={p.label} type="button" className="deal-follow-chip" disabled={!!busy} onClick={() => setFollowAt(p.at)}>
              {p.label}
            </button>
          ))}
          {deal.nextFollowAt && (
            <button type="button" className="deal-follow-chip" disabled={!!busy} onClick={() => setFollowAt(null)}>
              清除
            </button>
          )}
        </div>
      )}

      {deal && (deal.mine || deal.canRelease) && list.length > 0 && (
        <div className="deal-stages" role="group" aria-label="业务阶段">
          {list.map((s) => (
            <button
              key={s.id}
              type="button"
              className={'deal-stage' + (deal.stage === s.id ? ' on' : '')}
              style={deal.stage === s.id ? { borderColor: s.color || deal.stageColor, color: s.color || deal.stageColor } : undefined}
              disabled={!!busy || (!deal.mine && !deal.canRelease)}
              onClick={() => setStage(s.id)}
              title={s.label}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {canEdit && editingNote && (
        <div className="deal-note-edit">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value.slice(0, 200))}
            placeholder="跟进备注（如：等对方确认交期）"
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveNote();
              if (e.key === 'Escape') {
                setNoteDraft(deal.note || '');
                setEditingNote(false);
              }
            }}
          />
          <button type="button" className="sl-btn vip" disabled={busy === 'note'} onClick={saveNote}>
            {busy === 'note' ? <Loader2 size={12} className="spin" /> : '保存'}
          </button>
          <button
            type="button"
            className="sl-btn ghost"
            onClick={() => {
              setNoteDraft(deal.note || '');
              setEditingNote(false);
            }}
          >
            取消
          </button>
        </div>
      )}

      <div className="deal-bar-actions">
        {canEdit && !editingNote && (
          <button
            type="button"
            className="sl-btn ghost"
            title="编辑跟进备注"
            onClick={() => setEditingNote(true)}
          >
            <StickyNote size={12} /> 备注
          </button>
        )}
        {events.length > 0 && (
          <button
            type="button"
            className="sl-btn ghost"
            title="认领与阶段变更记录"
            onClick={() => setShowLog((v) => !v)}
          >
            <History size={12} /> 记录
          </button>
        )}
        {!deal && hasCompany && (
          <>
            <button type="button" className="sl-btn vip" disabled={!!busy} onClick={() => claim(false, 'company')} title="认领整个公司域名">
              {busy === 'claim' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 我来跟 · 公司
            </button>
            <button type="button" className="sl-btn" disabled={!!busy} onClick={() => claim(false, 'address')} title="只认领当前联系人">
              {busy === 'claim-person' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 仅此人
            </button>
          </>
        )}
        {!deal && !hasCompany && (
          <button type="button" className="sl-btn vip" disabled={!!busy} onClick={() => claim(false)}>
            {busy === 'claim' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 我来跟
          </button>
        )}
        {showClaimPerson && deal && !deal.mine && (
          <button
            type="button"
            className="sl-btn vip"
            disabled={!!busy}
            title="同事已认领公司域时，可只认领当前采购邮箱"
            onClick={() => claim(false, 'address')}
          >
            {busy === 'claim-person' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 仅认领此人
          </button>
        )}
        {showSplit && (
          <button type="button" className="sl-btn" disabled={!!busy} onClick={split} title="释放公司锁，改为只跟当前联系人">
            {busy === 'split' ? <Loader2 size={12} className="spin" /> : <Split size={12} />} 拆到个人
          </button>
        )}
        {deal?.mine && (
          <button type="button" className="sl-btn" disabled={!!busy} onClick={release}>
            {busy === 'release' ? <Loader2 size={12} className="spin" /> : <Unlock size={12} />} 释放
          </button>
        )}
        {deal && !deal.mine && deal.canTakeover && (
          <button
            type="button"
            className="sl-btn"
            disabled={!!busy}
            title="仅管理员可强制接管"
            onClick={() => claim(true, deal.scopeKind === 'address' ? 'address' : 'company')}
          >
            {busy === 'claim' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 接管
          </button>
        )}
      </div>

      {showLog && events.length > 0 && (
        <ul className="deal-event-log">
          {events.map((ev) => (
            <li key={ev.id}>
              <b>{ev.actor?.name}</b>
              <span>{ACTION_LABEL[ev.action] || ev.action}</span>
              {ev.detail ? <span className="muted">{ev.detail}</span> : null}
              <time>{formatShortDateTime(ev.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
