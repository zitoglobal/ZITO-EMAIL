import React, { useEffect, useState } from 'react';
import { Hand, Unlock, Loader2, GitBranch, History, StickyNote, CalendarClock, Split, ChevronDown, Package } from 'lucide-react';
import { api, qs } from '../api.js';
import { FOLLOW_SEQ_DAYS, SAMPLE_STATUS_LABEL, SAMPLE_TYPE_LABEL, stageChecklist } from '../apparelPresets.js';
import { formatShortDateTime } from '../utils.js';

const ACTION_LABEL = {
  claim: '认领',
  release: '释放',
  stage: '改阶段',
  takeover: '接管',
  assign: '指派',
  follow: '跟进日',
  follow_seq: '跟进序列',
  split: '拆到个人',
  commerce: '报价',
  sample: '样品',
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
  const [showCommerce, setShowCommerce] = useState(false);
  const [commerce, setCommerce] = useState({
    styleNo: '', currency: 'USD', amount: '', moq: '', leadDays: '', incoterm: '', quoteValidUntil: '', brandId: '',
  });
  const [sampleDraft, setSampleDraft] = useState({ sampleType: 'sms', trackingNo: '', status: 'planned' });
  const [styleQuick, setStyleQuick] = useState({ styleNo: '', colorway: '', sizeRange: '', unitPrice: '', moq: '', currency: 'USD' });
  const [brandList, setBrandList] = useState([]);
  const hasCompany = !!(scopes?.company || scope?.kind === 'company' || deal?.scopeKind === 'company');
  const visible = !!(scope || deal || scopes?.person);

  useEffect(() => {
    api('/brands')
      .then((d) => setBrandList(d.brands || []))
      .catch(() => setBrandList([]));
  }, []);

  useEffect(() => {
    setNoteDraft(deal?.note || '');
    setEditingNote(false);
    setCommerce({
      styleNo: deal?.styleNo || '',
      currency: deal?.currency || 'USD',
      amount: deal?.amount != null ? String(deal.amount) : '',
      moq: deal?.moq || '',
      leadDays: deal?.leadDays != null ? String(deal.leadDays) : '',
      incoterm: deal?.incoterm || '',
      quoteValidUntil: deal?.quoteValidUntil
        ? new Date(deal.quoteValidUntil).toISOString().slice(0, 10)
        : '',
      brandId: deal?.brandId != null ? String(deal.brandId) : '',
    });
  }, [deal?.id, deal?.note, deal?.styleNo, deal?.amount, deal?.moq, deal?.leadDays, deal?.incoterm, deal?.quoteValidUntil, deal?.currency, deal?.brandId]);

  useEffect(() => {
    const onHotkey = (e) => {
      const action = e.detail?.action;
      if (action === 'stage') {
        setShowCommerce(false);
        document.getElementById('deal-stages-focus')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.querySelector('#deal-stages-focus .deal-stage')?.focus?.();
      }
      if (action === 'follow') {
        document.getElementById('deal-follow-focus')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.querySelector('#deal-follow-focus .deal-follow-chip')?.focus?.();
      }
    };
    window.addEventListener('zm-deal-hotkey', onHotkey);
    return () => window.removeEventListener('zm-deal-hotkey', onHotkey);
  }, []);

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

  function bumpDeal(nextDeal, reason) {
    onChange?.(nextDeal);
    try {
      window.dispatchEvent(
        new CustomEvent('zm-deal', {
          detail: { dealId: nextDeal?.id || deal?.id, reason, deal: nextDeal },
        })
      );
    } catch {
      /* ignore */
    }
  }

  async function claim(force = false, scopeKind) {
    setBusy(scopeKind === 'address' ? 'claim-person' : 'claim');
    try {
      const d = await api('/deals/claim', {
        method: 'POST',
        body: { address, threadId, messageId: messageId || undefined, force, scopeKind },
      });
      bumpDeal(d.deal, 'claim');
      const label =
        scopeKind === 'address'
          ? `已认领联系人 ${d.deal.scopeLabel}`
          : force
            ? '已接管认领'
            : `已认领 ${d.deal.scopeLabel}`;
      notify(label, 'success');
    } catch (e) {
      if (e.status === 409 && e.deal) {
        bumpDeal(e.deal, 'claim-conflict');
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
        `将「${deal.scopeLabel}」拆到个人「${address}」？\n公司域认领会释放，同事可跟同域其它采购；报价与样品会保留到个人认领。`
      )
    ) {
      return;
    }
    setBusy('split');
    try {
      const d = await api(`/deals/${deal.id}/split`, { method: 'POST', body: {} });
      bumpDeal(d.deal, 'split');
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
      bumpDeal(null, 'release');
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
      bumpDeal(d.deal, 'stage');
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
      bumpDeal(d.deal, 'note');
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
      bumpDeal(d.deal, 'follow');
      notify(ts ? `下次跟进：${formatShortDateTime(ts)}` : '已清除跟进日');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function saveCommerce() {
    if (!deal?.id) return;
    setBusy('commerce');
    try {
      const body = {
        styleNo: commerce.styleNo,
        currency: commerce.currency || 'USD',
        amount: commerce.amount === '' ? null : Number(commerce.amount),
        moq: commerce.moq,
        leadDays: commerce.leadDays === '' ? null : Number(commerce.leadDays),
        incoterm: commerce.incoterm,
        quoteValidUntil: commerce.quoteValidUntil
          ? new Date(commerce.quoteValidUntil + 'T12:00:00').getTime()
          : null,
        brandId: commerce.brandId === '' ? null : Number(commerce.brandId),
      };
      const d = await api(`/deals/${deal.id}`, { method: 'PATCH', body });
      bumpDeal(d.deal, 'commerce');
      notify('报价要点已保存', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function quickStyle() {
    if (!deal?.id || !styleQuick.styleNo.trim()) return;
    setBusy('style');
    try {
      const r = await api(`/deals/${deal.id}/styles`, {
        method: 'POST',
        body: {
          styleNo: styleQuick.styleNo.trim(),
          colorway: styleQuick.colorway.trim(),
          sizeRange: styleQuick.sizeRange.trim(),
          unitPrice: styleQuick.unitPrice === '' ? null : Number(styleQuick.unitPrice),
          moq: styleQuick.moq.trim(),
          currency: styleQuick.currency || commerce.currency || 'USD',
        },
      });
      setStyleQuick({ styleNo: '', colorway: '', sizeRange: '', unitPrice: '', moq: '', currency: styleQuick.currency || 'USD' });
      bumpDeal({ ...deal, styles: r.styles || [] }, 'style');
      notify('已添加款号', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function quickSample() {
    if (!deal?.id) return;
    setBusy('sample');
    try {
      const r = await api(`/deals/${deal.id}/samples`, { method: 'POST', body: sampleDraft });
      const next = r.deal || deal;
      bumpDeal(next, 'sample');
      const staged = r.deal && r.deal.stage !== deal.stage;
      notify(
        staged
          ? `样品已记 · 阶段已推进为「${r.deal.stageLabel}」`
          : '样品记录已添加',
        'success'
      );
      setSampleDraft({ sampleType: 'sms', trackingNo: '', status: 'sent' });
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
        <div id="deal-follow-focus" className="deal-follow-row" title="客户级下次跟进日（快捷键 Shift+F）">
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
        <div id="deal-stages-focus" className="deal-stages" role="group" aria-label="业务阶段（快捷键 Shift+S）">
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

      {deal?.mine && stageChecklist(deal.stage) && (
        <div className="deal-stage-tip" title="服装外贸阶段核对清单">
          {stageChecklist(deal.stage)}
          {FOLLOW_SEQ_DAYS[deal.stage] && deal.autoFollowSeq !== false && (
            <span className="deal-seq-hint"> · 序列：本阶段后 {FOLLOW_SEQ_DAYS[deal.stage]} 天跟进</span>
          )}
        </div>
      )}

      {canEdit && (
        <div className="deal-commerce">
          <button type="button" className="deal-commerce-toggle" onClick={() => setShowCommerce((v) => !v)}>
            <Package size={12} /> 报价 / 样品
            <ChevronDown size={12} className={showCommerce ? 'rot' : ''} />
          </button>
          {showCommerce && (
            <div className="deal-commerce-body">
              <div className="deal-commerce-grid">
                <label>款号<input value={commerce.styleNo} onChange={(e) => setCommerce((c) => ({ ...c, styleNo: e.target.value }))} placeholder="Style No." /></label>
                <label>币种<input value={commerce.currency} onChange={(e) => setCommerce((c) => ({ ...c, currency: e.target.value }))} placeholder="USD" /></label>
                <label title="整单/订单金额（非单款单价）">订单金额<input value={commerce.amount} onChange={(e) => setCommerce((c) => ({ ...c, amount: e.target.value }))} placeholder="整单" inputMode="decimal" /></label>
                <label>MOQ<input value={commerce.moq} onChange={(e) => setCommerce((c) => ({ ...c, moq: e.target.value }))} placeholder="500 pcs" /></label>
                <label>交期(天)<input value={commerce.leadDays} onChange={(e) => setCommerce((c) => ({ ...c, leadDays: e.target.value }))} placeholder="45" inputMode="numeric" /></label>
                <label>贸易术语
                  <select value={commerce.incoterm} onChange={(e) => setCommerce((c) => ({ ...c, incoterm: e.target.value }))}>
                    <option value="">—</option>
                    {['FOB', 'CIF', 'CFR', 'EXW', 'DDP', 'DAP', 'FCA'].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </label>
                <label>报价有效期<input type="date" value={commerce.quoteValidUntil} onChange={(e) => setCommerce((c) => ({ ...c, quoteValidUntil: e.target.value }))} /></label>
                <label>品牌
                  <select value={commerce.brandId} onChange={(e) => setCommerce((c) => ({ ...c, brandId: e.target.value }))}>
                    <option value="">—</option>
                    {brandList.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="deal-commerce-actions">
                <button type="button" className="sl-btn vip" disabled={busy === 'commerce'} onClick={saveCommerce}>
                  {busy === 'commerce' ? <Loader2 size={12} className="spin" /> : null} 保存报价
                </button>
                <label className="deal-seq-toggle">
                  <input
                    type="checkbox"
                    checked={deal.autoFollowSeq !== false}
                    onChange={async (e) => {
                      try {
                        const d = await api(`/deals/${deal.id}`, { method: 'PATCH', body: { autoFollowSeq: e.target.checked } });
                        bumpDeal(d.deal, 'follow-seq');
                      } catch (err) {
                        notify(err.message, 'error');
                      }
                    }}
                  />
                  自动跟进序列
                </label>
              </div>
              <p className="deal-amount-hint muted">
                上方「订单金额」= 整单；下方「单价」= 各款 FOB/件价。多款报价请用加款，勿把单价填进订单金额。
              </p>
              <div className="deal-style-quick" aria-label="多款快捷添加">
                <input
                  value={styleQuick.styleNo}
                  onChange={(e) => setStyleQuick((s) => ({ ...s, styleNo: e.target.value }))}
                  placeholder="多款：Style No."
                />
                <input
                  value={styleQuick.colorway}
                  onChange={(e) => setStyleQuick((s) => ({ ...s, colorway: e.target.value }))}
                  placeholder="色组"
                />
                <input
                  value={styleQuick.sizeRange}
                  onChange={(e) => setStyleQuick((s) => ({ ...s, sizeRange: e.target.value }))}
                  placeholder="尺码"
                />
                <input
                  value={styleQuick.unitPrice}
                  onChange={(e) => setStyleQuick((s) => ({ ...s, unitPrice: e.target.value }))}
                  placeholder="单价"
                  inputMode="decimal"
                />
                <input
                  value={styleQuick.moq}
                  onChange={(e) => setStyleQuick((s) => ({ ...s, moq: e.target.value }))}
                  placeholder="MOQ"
                />
                <button type="button" className="sl-btn" disabled={busy === 'style' || !styleQuick.styleNo.trim()} onClick={quickStyle}>
                  {busy === 'style' ? <Loader2 size={12} className="spin" /> : null} 加款
                </button>
              </div>
              <div className="deal-sample-row">
                <select value={sampleDraft.sampleType} onChange={(e) => setSampleDraft((s) => ({ ...s, sampleType: e.target.value }))}>
                  {Object.entries(SAMPLE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <select value={sampleDraft.status} onChange={(e) => setSampleDraft((s) => ({ ...s, status: e.target.value }))}>
                  {Object.entries(SAMPLE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input
                  value={sampleDraft.trackingNo}
                  onChange={(e) => setSampleDraft((s) => ({ ...s, trackingNo: e.target.value }))}
                  placeholder="快递单号"
                />
                <button type="button" className="sl-btn" disabled={busy === 'sample'} onClick={quickSample}>记样品</button>
              </div>
            </div>
          )}
        </div>
      )}

      {canEdit && editingNote && (
        <div className="deal-note-edit">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value.slice(0, 200))}
            placeholder="本成交备注（如：等 PP；跟人备注在客户栏）"
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
            title="编辑本成交备注（联系人长期备注在客户栏）"
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
