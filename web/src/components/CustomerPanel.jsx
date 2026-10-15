import React, { useEffect, useState } from 'react';
import { X, Crown, Bell, BellOff, Hourglass, Users, Reply, Clock } from 'lucide-react';
import { api } from '../api.js';
import { avatarColor, displayName, formatListDate, initials, relativeTime, waitText } from '../utils.js';

const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

/** 客户栏 / 抽屉：复用 sender + sender_rules，可选最近线程与跟进状态 */
export default function CustomerPanel({
  address,
  sender,
  slaHours,
  listItem,
  onRule,
  onOpenThread,
  onClose,
  mode = 'rail', // rail | drawer
}) {
  const [recent, setRecent] = useState(sender?.recentSubjects || []);
  const [loading, setLoading] = useState(false);
  const info = sender && { ...sender, address: address || sender.address };
  const vip = info?.rule?.kind === 'vip';
  const muted = info?.rule?.kind === 'muted';
  const target = info?.company?.domain ? '@' + info.company.domain : null;
  const title = info?.company?.name || displayName({ name: info?.name, address: info?.address }) || info?.address || '客户';
  const suggest = info?.vipSuggest;
  const empty = !info?.address;

  useEffect(() => {
    setRecent(sender?.recentSubjects || []);
  }, [sender]);

  useEffect(() => {
    if (!info?.address) {
      setRecent([]);
      setLoading(false);
      return undefined;
    }
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

  const priority = listItem?.priority;
  const waitingOnThem = !!listItem?.waitingOnThem;
  const needReply = listItem?._section === 'reply';
  const followUp = listItem?._section === 'follow';
  const effectiveSla = slaHours ?? priority?.slaHours;
  const showStatus = !empty && listItem && (waitingOnThem || needReply || followUp || priority?.overdue || effectiveSla != null || listItem?.remindStage >= 1);

  if (empty) {
    return (
      <div className={'customer-panel empty-rail' + (mode === 'drawer' ? ' in-drawer' : '')} role="complementary" aria-label="客户">
        <div className="customer-panel-head">
          <div className="customer-empty-icon" aria-hidden>
            <Users size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>客户</h3>
            <small>选择一封邮件查看客户</small>
          </div>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭客户面板"><X size={18} /></button>
          )}
        </div>
        <div className="customer-panel-body">
          <div className="customer-empty">
            <div className="customer-empty-art" aria-hidden>
              <Users size={28} strokeWidth={1.5} />
            </div>
            <b>销售台已就绪</b>
            <small>从左侧点开一封邮件，这里会显示公司、跟进状态、VIP 与最近往来——选信只换内容，栏位保持不动。</small>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={'customer-panel' + (mode === 'drawer' ? ' in-drawer' : '')} role="complementary" aria-label="客户">
      {/* ① 身份 */}
      <div className="customer-panel-head customer-sec-identity">
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
        <div className="customer-sec">
          <div className="relation-card-badges">
            {TIER_TEXT[info?.tier] && (
              <span className={'tag tier-' + info.tier}>{info.tier === 'vip' && <Crown size={10} />} {TIER_TEXT[info.tier]}</span>
            )}
            {effectiveSla != null && ['vip', 'customer', 'new'].includes(info?.tier) && (
              <span className="relation-sla"><Hourglass size={11} /> SLA {effectiveSla}h</span>
            )}
          </div>
          <div className="sender-line" style={{ margin: '8px 0 0' }}>
            <span className="sl-item">来信 {info?.received ?? 0} 封</span>
            {(info?.sent || 0) > 0 && <span className="sl-item">你发过 {info.sent} 封</span>}
            {info?.lastSent && <span className="sl-item">上次给 TA 发信 {relativeTime(info.lastSent)}</span>}
          </div>
        </div>

        {/* ② 状态 */}
        {showStatus && (
          <div className="customer-sec customer-status-strip" aria-label="跟进状态">
            <div className="customer-section-title">当前状态</div>
            <div className="customer-status-chips">
              {waitingOnThem && (
                <span className="cstatus waiting-them" title="已回复，等待对方回信">
                  <Hourglass size={12} /> 等对方
                </span>
              )}
              {(needReply || priority?.overdue) && !waitingOnThem && (
                <span className={'cstatus need-reply' + (priority?.overdue ? ' over' : '')} title={priority?.overdue ? '已超过回复时限' : '等待你回复'}>
                  <Reply size={12} /> {priority?.overdue ? '已超时' : '待回复'}
                  {priority?.waitingHours >= 1 ? ` · ${waitText(priority.waitingHours)}` : ''}
                </span>
              )}
              {followUp && !waitingOnThem && (
                <span className="cstatus follow" title="待跟进">
                  <Clock size={12} /> 待跟进
                </span>
              )}
              {effectiveSla != null && (
                <span className="cstatus sla" title="回复时限">
                  <Hourglass size={12} /> SLA {effectiveSla}h
                </span>
              )}
              {listItem?.remindStage >= 1 && (
                <span className={'cstatus remind r' + Math.min(3, listItem.remindStage)}>
                  {listItem.remindStage >= 3 ? '终提醒' : listItem.remindStage === 2 ? '提醒 2' : '提醒'}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ③ 动作 */}
        <div className="customer-sec">
          <div className="customer-section-title">快捷操作</div>
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
        </div>

        {/* ④ 最近往来 */}
        <div className="customer-sec">
          <div className="customer-section-title">最近往来</div>
          {loading && !recent.length && (
            <div className="customer-skel" aria-busy="true" aria-label="加载中">
              <div className="skel-line" />
              <div className="skel-line short" />
              <div className="skel-line" />
            </div>
          )}
          {!loading && !recent.length && <small className="muted">暂无足够的往来记录</small>}
          <div className="customer-thread-list">
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
