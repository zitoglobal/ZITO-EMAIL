import React, { useState } from 'react';
import { Hand, Unlock, Loader2, GitBranch } from 'lucide-react';
import { api } from '../api.js';

/**
 * 团队认领 + 业务阶段条（邮箱内销售台）
 */
export default function DealBar({ deal, scope, stages = [], address, threadId, notify, onChange }) {
  const [busy, setBusy] = useState('');
  if (!scope && !deal) return null;

  async function claim(force = false) {
    setBusy('claim');
    try {
      const d = await api('/deals/claim', {
        method: 'POST',
        body: { address, threadId, force },
      });
      onChange?.(d.deal);
      notify(force ? '已接管认领' : `已认领 ${d.deal.scopeLabel}`, 'success');
    } catch (e) {
      if (e.status === 409 && e.deal) {
        onChange?.(e.deal);
        notify(e.message, 'error');
      } else notify(e.message, 'error');
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
      const d = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { stage } });
      onChange?.(d.deal);
      notify(`阶段已更新为 ${d.deal.stageLabel}`);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const list = stages.length ? stages : deal ? [{ id: deal.stage, label: deal.stageLabel, color: deal.stageColor }] : [];

  return (
    <div className={'deal-bar' + (deal && !deal.mine ? ' taken' : '') + (deal?.mine ? ' mine' : '')}>
      <div className="deal-bar-main">
        <GitBranch size={14} />
        <div className="deal-bar-text">
          {!deal && (
            <>
              <b>未认领</b>
              <span>客户 {scope?.label || address} — 认领后同事可见归属，减少撞单报价</span>
            </>
          )}
          {deal?.mine && (
            <>
              <b>我已认领 · {deal.scopeLabel}</b>
              <span>当前阶段：{deal.stageLabel}{deal.note ? ` · ${deal.note}` : ''}</span>
            </>
          )}
          {deal && !deal.mine && (
            <>
              <b>{deal.owner.name} 已认领 · {deal.scopeLabel}</b>
              <span>阶段 {deal.stageLabel} — 请先确认再回复，避免重复报价</span>
            </>
          )}
        </div>
      </div>

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

      <div className="deal-bar-actions">
        {!deal && (
          <button type="button" className="sl-btn vip" disabled={!!busy} onClick={() => claim(false)}>
            {busy === 'claim' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 我来跟
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
            onClick={() => claim(true)}
          >
            {busy === 'claim' ? <Loader2 size={12} className="spin" /> : <Hand size={12} />} 接管
          </button>
        )}
      </div>
    </div>
  );
}
