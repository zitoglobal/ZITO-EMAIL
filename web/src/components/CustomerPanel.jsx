import React, { useEffect, useState } from 'react';
import { X, Crown, Bell, BellOff, Hourglass, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { avatarColor, displayName, formatListDate, initials, relativeTime } from '../utils.js';

const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

/** 客户栏 / 抽屉：复用 sender + sender_rules，可选最近线程 */
export default function CustomerPanel({
  address, sender, slaHours, onRule, onOpenThread, onClose, mode = 'rail', // rail | drawer
}) {
  const [recent, setRecent] = useState(sender?.recentSubjects || []);
  const [loading, setLoading] = useState(false);
  const info = sender && { ...sender, address: address || sender.address };
  const vip = info?.rule?.kind === 'vip';
  const muted = info?.rule?.kind === 'muted';
  const target = info?.company?.domain ? '@' + info.company.domain : null;
  const title = info?.company?.name || displayName({ name: info?.name, address: info?.address }) || info?.address || '客户';
  const suggest = info?.vipSuggest;

  useEffect(() => {
    setRecent(sender?.recentSubjects || []);
  }, [sender]);

  useEffect(() => {
    if (!info?.address) return;
    let alive = true;
    setLoading(true);
    api('/messages' + `?q=${encodeURIComponent('from:' + info.address)}&limit=5`)
      .then((d) => {
        if (!alive) return;
        const rows = (d.messages || []).slice(0, 5).map((m) => ({
          id: m.id,
          subject: m.subject || '(无主题)',
          date: m.date,
        }));
        if (rows.length) setRecent(rows);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [info?.address]);

  if (!info?.address && !loading) {
    return (
      <div className={'customer-panel' + (mode === 'drawer' ? ' in-drawer' : '')}>
        <div className="customer-panel-head">
          <div>
            <h3>客户</h3>
            <small>选择一封邮件查看客户</small>
          </div>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭客户面板"><X size={18} /></button>
          )}
        </div>
        <div className="customer-panel-body">
          <div className="empty" style={{ padding: 40 }}><small>暂无客户上下文</small></div>
        </div>
      </div>
    );
  }

  return (
    <div className={'customer-panel' + (mode === 'drawer' ? ' in-drawer' : '')} role="complementary" aria-label="客户">
      <div className="customer-panel-head">
        <span className="avatar" style={{ background: avatarColor(info?.address) }}>{initials({ name: title, address: info?.address })}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 title={title}>{title}</h3>
          <small>{info?.company?.domain || info?.address}</small>
        </div>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭客户面板"><X size={18} /></button>
        )}
      </div>
      <div className="customer-panel-body">
        <div>
          <div className="relation-card-badges">
            {TIER_TEXT[info?.tier] && (
              <span className={'tag tier-' + info.tier}>{info.tier === 'vip' && <Crown size={10} />} {TIER_TEXT[info.tier]}</span>
            )}
            {slaHours != null && ['vip', 'customer', 'new'].includes(info?.tier) && (
              <span className="relation-sla"><Hourglass size={11} /> SLA {slaHours}h</span>
            )}
          </div>
          <div className="sender-line" style={{ margin: '8px 0 0' }}>
            <span className="sl-item">来信 {info?.received ?? 0} 封</span>
            {(info?.sent || 0) > 0 && <span className="sl-item">你发过 {info.sent} 封</span>}
            {info?.lastSent && <span className="sl-item">上次给 TA 发信 {relativeTime(info.lastSent)}</span>}
          </div>
        </div>

        <div className="customer-actions">
          {info?.rule ? (
            <button type="button" className="sl-btn" onClick={() => onRule?.(info.rule.key, null)}>
              {vip ? <><Crown size={12} /> 取消 VIP</> : <><Bell size={12} /> 取消静音</>}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="sl-btn vip"
                onClick={() => onRule?.(suggest?.key || target || info.address, 'vip', info.company?.name)}
                title={suggest ? '确认后按 VIP SLA 优先分诊，不会自动升级' : undefined}
              >
                <Crown size={12} /> {suggest ? '确认 VIP' : `设为 VIP${target ? '（公司）' : ''}`}
              </button>
              {!muted && (
                <button type="button" className="sl-btn" onClick={() => onRule?.(info.address, 'muted')} title="静音后其来信不进入今日待办">
                  <BellOff size={12} /> 静音
                </button>
              )}
            </>
          )}
        </div>

        {suggest && !vip && (
          <div className="vip-suggest">
            <Crown size={12} />
            <span>建议设为 VIP：{(suggest.reasons || []).join(' · ')}</span>
          </div>
        )}

        <div>
          <div className="customer-section-title">最近往来</div>
          {loading && !recent.length && <div className="muted"><Loader2 size={14} className="spin" /> 加载中…</div>}
          {!loading && !recent.length && <small className="muted">暂无足够的往来记录</small>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map((r, i) => (
              <button
                key={r.id || i}
                type="button"
                className="customer-thread"
                onClick={() => r.id && onOpenThread?.(r.id)}
                disabled={!r.id}
              >
                <b>{r.subject}</b>
                <small>{r.date ? formatListDate(r.date) : ''}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
