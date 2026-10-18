import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Crown, Bell, BellOff, Hourglass, Users, Reply, Clock, Plus, Loader2, UserPlus, CalendarClock, Send, ArrowDownLeft, ArrowUpRight, Sparkles, Package, FolderOpen, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { ASSET_KIND_LABEL, FOLLOW_SEQ_DAYS, SAMPLE_STATUS_LABEL, SAMPLE_TYPE_LABEL } from '../apparelPresets.js';
import { avatarColor, displayName, formatListDate, formatShortDateTime, initials, relativeTime, waitText } from '../utils.js';

const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

const EVENT_LABEL = {
  claim: '认领',
  takeover: '接管',
  release: '释放',
  stage: '阶段',
  follow: '跟进日',
  assign: '指派',
  split: '拆分',
};

const STATUS_LABEL = {
  waiting_them: '等对方回复',
  need_reply: '待你回复',
  follow_due: '跟进日到期',
  idle: '暂无紧急',
};

/** 读信/已发场景下解析「对方」地址 */
function peerAddressOf(address, sender, listItem) {
  if (listItem?._section === 'follow' && listItem.follow?.to?.address) return listItem.follow.to.address;
  if (listItem?.waitingOnThem && listItem.to?.[0]?.address) return listItem.to[0].address;
  return address || sender?.address || listItem?.from?.address || null;
}

/** 客户栏 / 抽屉：决策面 + 时间线 + Person 主数据 */
export default function CustomerPanel({
  address,
  sender,
  slaHours,
  listItem,
  onRule,
  onOpenThread,
  onClose,
  onOpenContacts,
  onFollowUp,
  onReplyPeer,
  mode = 'rail', // rail | drawer
}) {
  const [recent, setRecent] = useState(sender?.recentSubjects || []);
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(false);
  const [person, setPerson] = useState(null);
  const [auto, setAuto] = useState(null);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [note, setNote] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [addrInput, setAddrInput] = useState('');
  const [busy, setBusy] = useState('');
  const [styles, setStyles] = useState([]);
  const [samples, setSamples] = useState([]);
  const [assets, setAssets] = useState([]);
  const [styleDraft, setStyleDraft] = useState('');
  const noteTimer = useRef(null);

  const peerAddr = useMemo(() => peerAddressOf(address, sender, listItem), [address, sender, listItem]);
  const info = sender && { ...sender, address: peerAddr || address || sender.address };
  const vip = info?.rule?.kind === 'vip' || person?.rule?.kind === 'vip';
  const muted = info?.rule?.kind === 'muted' || person?.rule?.kind === 'muted';
  const target = info?.company?.domain ? '@' + info.company.domain : null;
  const companyLabel = person?.company || info?.company?.name;
  const title =
    person?.displayName ||
    companyLabel ||
    displayName({ name: info?.name, address: info?.address }) ||
    info?.address ||
    '客户';
  const suggest = info?.vipSuggest;
  const empty = !peerAddr;

  useEffect(() => {
    setRecent(sender?.recentSubjects || []);
  }, [sender]);

  useEffect(() => {
    if (!peerAddr) {
      setRecent([]);
      setTimeline(null);
      setPerson(null);
      setAuto(null);
      setNote('');
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api('/contact-persons/resolve?address=' + encodeURIComponent(peerAddr))
      .then((d) => {
        if (!alive) return;
        setPerson(d.person || null);
        setAuto(d.auto || null);
        setNote(d.person?.note || '');
        if (d.recent?.length) setRecent(d.recent);
      })
      .catch(() => {
        if (!alive) return;
        setPerson(null);
      });

    api('/customer/timeline?address=' + encodeURIComponent(peerAddr) + '&limit=18')
      .then((d) => {
        if (!alive) return;
        setTimeline(d);
        const mails = (d.items || []).filter((x) => x.type === 'mail');
        if (mails.length) {
          setRecent(
            mails.slice(0, 8).map((m) => ({
              id: m.id,
              subject: m.subject,
              date: m.date,
              direction: m.direction,
            }))
          );
        }
      })
      .catch(() => alive && setTimeline(null))
      .finally(() => alive && setLoading(false));

    api('/contact-tags')
      .then((d) => alive && setTagCatalog(d.tags || []))
      .catch(() => {});

    api('/customer-assets?address=' + encodeURIComponent(peerAddr) + '&limit=30')
      .then((d) => alive && setAssets(d.assets || []))
      .catch(() => alive && setAssets([]));

    return () => {
      alive = false;
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, [peerAddr]);

  const dealId = timeline?.deal?.id || listItem?.deal?.id;

  const reloadArtifacts = useCallback((id) => {
    if (!id) {
      setStyles([]);
      setSamples([]);
      return;
    }
    Promise.all([
      api(`/deals/${id}/styles`),
      api(`/deals/${id}/samples`),
    ])
      .then(([st, sa]) => {
        setStyles(st.styles || []);
        setSamples(sa.samples || []);
      })
      .catch(() => {
        setStyles([]);
        setSamples([]);
      });
  }, []);

  useEffect(() => {
    reloadArtifacts(dealId);
  }, [dealId, reloadArtifacts]);

  useEffect(() => {
    if (!peerAddr) return undefined;
    const onBump = (e) => {
      const reason = e.detail?.reason;
      const id = e.detail?.dealId || dealId;
      if (reason === 'sample' || reason === 'commerce' || reason === 'split' || reason === 'stage' || reason === 'follow') {
        reloadArtifacts(id);
      }
      if (reason === 'commerce' || reason === 'split' || reason === 'stage' || reason === 'follow' || reason === 'claim') {
        api('/customer/timeline?address=' + encodeURIComponent(peerAddr) + '&limit=18')
          .then((d) => setTimeline(d))
          .catch(() => {});
      }
      if (peerAddr) {
        api('/customer-assets?address=' + encodeURIComponent(peerAddr) + '&limit=30')
          .then((d) => setAssets(d.assets || []))
          .catch(() => {});
      }
    };
    window.addEventListener('zm-deal', onBump);
    return () => window.removeEventListener('zm-deal', onBump);
  }, [peerAddr, dealId, reloadArtifacts]);

  function scheduleNoteSave(value) {
    setNote(value);
    if (!person?.id) return;
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(async () => {
      setNoteSaving(true);
      try {
        const d = await api(`/contact-persons/${person.id}`, { method: 'PATCH', body: { note: value } });
        setPerson(d.person);
      } catch {
        /* 静默：客户栏不打断 */
      } finally {
        setNoteSaving(false);
      }
    }, 600);
  }

  async function addToContacts() {
    if (!info?.address) return;
    setBusy('create');
    try {
      const d = await api('/contact-persons', {
        method: 'POST',
        body: {
          displayName: info?.name || '',
          company: info?.company?.name || '',
          address: info.address,
        },
      });
      setPerson(d.person);
      setAuto(null);
      setNote(d.person.note || '');
    } catch (e) {
      // 若已存在则 resolve
      if (e.status === 409 || /已属于/.test(e.message || '')) {
        const r = await api('/contact-persons/resolve?address=' + encodeURIComponent(info.address));
        setPerson(r.person);
        setNote(r.person?.note || '');
      }
    } finally {
      setBusy('');
    }
  }

  async function toggleTag(tagId, on) {
    if (!person?.id) return;
    try {
      const d = await api(`/contact-persons/${person.id}/tags`, {
        method: 'POST',
        body: on ? { remove: [tagId] } : { add: [tagId] },
      });
      setPerson(d.person);
    } catch {
      /* ignore */
    }
  }

  async function addAlias(e) {
    e?.preventDefault();
    if (!person?.id || !addrInput.trim()) return;
    setBusy('addr');
    try {
      const d = await api(`/contact-persons/${person.id}/addresses`, {
        method: 'POST',
        body: { address: addrInput.trim() },
      });
      setPerson(d.person);
      setAddrInput('');
      if (d.recent) setRecent(d.recent);
      // 刷新多地址往来
      const r = await api(`/contact-persons/${person.id}`);
      if (r.recent?.length) setRecent(r.recent);
    } catch (err) {
      window.alert(err.message || '添加失败');
    } finally {
      setBusy('');
    }
  }

  const priority = listItem?.priority;
  const waitingOnThem = !!listItem?.waitingOnThem || listItem?._section === 'follow' || timeline?.decision?.status === 'waiting_them';
  const needReply = listItem?._section === 'reply' || timeline?.decision?.status === 'need_reply';
  const followUp = listItem?._section === 'follow';
  const effectiveSla = slaHours ?? priority?.slaHours;
  const decision = timeline?.decision;
  const deal = timeline?.deal || listItem?.deal;
  const tagIds = new Set((person?.tags || []).map((t) => t.id));

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
            <small>点开一封邮件，这里显示客户时间线：该不该动、怎么动、往来与阶段记录。</small>
            {onOpenContacts && (
              <button type="button" className="btn-ghost sm" style={{ marginTop: 12 }} onClick={onOpenContacts}>
                打开联系人
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={'customer-panel' + (mode === 'drawer' ? ' in-drawer' : '')} role="complementary" aria-label="客户">
      <div className="customer-panel-head customer-sec-identity">
        <span className="avatar" style={{ background: avatarColor(info?.address) }}>{initials({ name: title, address: info?.address })}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 title={title}>{title}</h3>
          <small>{companyLabel || info?.company?.domain || info?.address}</small>
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
          {!person && (
            <button type="button" className="btn-ghost sm" style={{ marginTop: 8 }} disabled={busy === 'create'} onClick={addToContacts}>
              {busy === 'create' ? <Loader2 size={12} className="spin" /> : <UserPlus size={12} />} 加到联系人
              {auto?.score ? `（往来 ${auto.score}）` : ''}
            </button>
          )}
        </div>

        {/* 决策面：该不该动、怎么动 */}
        <div className="customer-sec customer-decision" aria-label="下一步决策">
          <div className="customer-section-title">
            <Sparkles size={12} /> 下一步
          </div>
          {loading && !decision && (
            <div className="customer-skel" aria-busy="true">
              <div className="skel-line" />
              <div className="skel-line short" />
            </div>
          )}
          {decision && (
            <div className={'customer-decision-card' + (decision.due ? ' due' : '')}>
              <div className="cd-row">
                <b>{STATUS_LABEL[decision.status] || decision.status}</b>
                {decision.waitingHours >= 1 && (
                  <span className="cd-wait">
                    <Hourglass size={11} /> {waitText(decision.waitingHours)}
                  </span>
                )}
              </div>
              <small className="cd-why">{decision.why}</small>
              {deal && (
                <div className="cd-deal">
                  <span className="pill">{deal.stageLabel || deal.stage}</span>
                  {deal.mine ? <span className="muted">我跟</span> : deal.owner?.name ? <span className="muted">{deal.owner.name} 跟</span> : null}
                  {deal.nextFollowAt ? <span className="muted">下次 {formatShortDateTime(deal.nextFollowAt)}</span> : null}
                </div>
              )}
              <div className="cd-actions">
                {(decision.status === 'waiting_them' || followUp || waitingOnThem) && onFollowUp && listItem && (
                  <button type="button" className="btn-primary sm" onClick={() => onFollowUp(listItem)}>
                    <Send size={12} /> {decision.suggestedAction?.label || '写跟进'}
                  </button>
                )}
                {(decision.status === 'need_reply' || needReply) && onReplyPeer && (
                  <button type="button" className="btn-primary sm" onClick={() => onReplyPeer(listItem || { id: decision.lastInId })}>
                    <Reply size={12} /> {decision.suggestedAction?.label || '回复'}
                  </button>
                )}
                {decision.lastOutId && (
                  <button type="button" className="btn-ghost sm" onClick={() => onOpenThread?.(decision.lastOutId)}>
                    看发出
                  </button>
                )}
                {decision.lastInId && (
                  <button type="button" className="btn-ghost sm" onClick={() => onOpenThread?.(decision.lastInId)}>
                    看来信
                  </button>
                )}
              </div>
              {decision.suggestedAction?.detail && <small className="muted cd-hint">{decision.suggestedAction.detail}</small>}
            </div>
          )}
          {!loading && !decision && (
            <div className="customer-status-chips">
              {waitingOnThem && (
                <span className="cstatus waiting-them">
                  <Hourglass size={12} /> 等对方
                </span>
              )}
              {(needReply || priority?.overdue) && !waitingOnThem && (
                <span className={'cstatus need-reply' + (priority?.overdue ? ' over' : '')}>
                  <Reply size={12} /> {priority?.overdue ? '已超时' : '待回复'}
                </span>
              )}
              {effectiveSla != null && (
                <span className="cstatus sla">
                  <Hourglass size={12} /> SLA {effectiveSla}h
                </span>
              )}
            </div>
          )}
        </div>

        {(deal || styles.length || samples.length || assets.length) && (
          <div className="customer-sec customer-commerce" aria-label="成交工件">
            {deal && (deal.amount != null || deal.styleNo || deal.moq) && (
              <>
                <div className="customer-section-title"><Package size={12} /> 报价要点</div>
                <div className="cd-commerce-summary">
                  {deal.styleNo && <span className="pill">款 {deal.styleNo}</span>}
                  {deal.amount != null && <span className="pill">{deal.currency || 'USD'} {deal.amount}</span>}
                  {deal.moq && <span className="muted">MOQ {deal.moq}</span>}
                  {deal.incoterm && <span className="muted">{deal.incoterm}</span>}
                  {deal.leadDays != null && <span className="muted">{deal.leadDays} 天</span>}
                  {FOLLOW_SEQ_DAYS[deal.stage] && deal.autoFollowSeq !== false && (
                    <small className="muted deal-seq-hint">序列：本阶段后 {FOLLOW_SEQ_DAYS[deal.stage]} 天</small>
                  )}
                </div>
              </>
            )}

            <div className="customer-section-title" style={{ marginTop: deal?.amount != null || deal?.styleNo ? 10 : 0 }}>
              款号
            </div>
            <ul className="customer-style-list">
              {styles.map((s) => (
                <li key={s.id}>
                  <b>{s.styleNo}</b>
                  {(s.colorway || s.sizeRange) && (
                    <small className="muted">{[s.colorway, s.sizeRange].filter(Boolean).join(' · ')}</small>
                  )}
                  {dealId && (
                    <button
                      type="button"
                      className="icon-btn xs"
                      title="删除"
                      onClick={async () => {
                        try {
                          await api(`/deals/${dealId}/styles/${s.id}`, { method: 'DELETE' });
                          setStyles((list) => list.filter((x) => x.id !== s.id));
                        } catch { /* ignore */ }
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </li>
              ))}
              {!styles.length && <li className="muted"><small>暂无款号，可在成交条添加</small></li>}
            </ul>
            {dealId && (
              <form
                className="glossary-add compact"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!styleDraft.trim()) return;
                  setBusy('style');
                  try {
                    const r = await api(`/deals/${dealId}/styles`, { method: 'POST', body: { styleNo: styleDraft.trim() } });
                    setStyles(r.styles || []);
                    setStyleDraft('');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <input value={styleDraft} onChange={(e) => setStyleDraft(e.target.value)} placeholder="新款号 Style No." />
                <button type="submit" className="btn-ghost xs" disabled={busy === 'style' || !styleDraft.trim()}>添加</button>
              </form>
            )}

            <div className="customer-section-title" style={{ marginTop: 10 }}>样品</div>
            <ul className="customer-sample-list">
              {samples.map((s) => (
                <li key={s.id}>
                  <span className="pill">{SAMPLE_TYPE_LABEL[s.sampleType] || s.sampleType}</span>
                  <span className="pill soft">{SAMPLE_STATUS_LABEL[s.status] || s.status}</span>
                  {s.trackingNo && <small>{s.trackingNo}</small>}
                  {s.sentAt && <small className="muted">{formatShortDateTime(s.sentAt)}</small>}
                </li>
              ))}
              {!samples.length && <li className="muted"><small>暂无样品记录</small></li>}
            </ul>

            <div className="customer-section-title" style={{ marginTop: 10 }}>
              <FolderOpen size={12} /> 资料库
            </div>
            <ul className="customer-asset-list">
              {assets.map((a) => (
                <li key={a.id}>
                  <a href={a.previewUrl || a.downloadUrl} target="_blank" rel="noreferrer" title={a.filename}>
                    <b>{a.title || a.filename}</b>
                    <small className="muted">{ASSET_KIND_LABEL[a.kind] || a.kind}{a.styleNo ? ` · ${a.styleNo}` : ''}</small>
                  </a>
                  <button
                    type="button"
                    className="icon-btn xs"
                    title="从资料库移除"
                    onClick={async () => {
                      try {
                        await api(`/customer-assets/${a.id}`, { method: 'DELETE' });
                        setAssets((list) => list.filter((x) => x.id !== a.id));
                      } catch { /* ignore */ }
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
              {!assets.length && <li className="muted"><small>读信附件可「收入资料库」</small></li>}
            </ul>
          </div>
        )}

        {person && (
          <div className="customer-sec">
            <div className="customer-section-title">
              备注 {noteSaving && <Loader2 size={10} className="spin" style={{ marginLeft: 4 }} />}
            </div>
            <textarea
              className="customer-note"
              value={note}
              onChange={(e) => scheduleNoteSave(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="付款习惯、旺季、对接人…"
            />
          </div>
        )}

        {(dealId || person) && (
          <div className="customer-sec">
            <div className="customer-section-title">
              <CalendarClock size={12} /> 下次跟进
              {dealId ? <small className="muted" style={{ marginLeft: 6 }}>成交跟进日</small> : null}
            </div>
            <div className="customer-follow-row">
              {[1, 3, 7].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="deal-follow-chip"
                  disabled={busy === 'follow'}
                  onClick={async () => {
                    const d = new Date();
                    d.setHours(9, 0, 0, 0);
                    d.setDate(d.getDate() + n);
                    setBusy('follow');
                    try {
                      if (dealId) {
                        const r = await api(`/deals/${dealId}`, {
                          method: 'PATCH',
                          body: { nextFollowAt: d.getTime() },
                        });
                        setTimeline((tl) => (tl ? { ...tl, deal: r.deal } : tl));
                        try {
                          window.dispatchEvent(new CustomEvent('zm-deal', { detail: { dealId, reason: 'follow', deal: r.deal } }));
                        } catch { /* ignore */ }
                      } else if (person?.id) {
                        const r = await api(`/contact-persons/${person.id}`, {
                          method: 'PATCH',
                          body: { nextFollowAt: d.getTime() },
                        });
                        setPerson(r.person);
                      }
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {n === 1 ? '明天' : n === 3 ? '3 天' : '一周'}
                </button>
              ))}
              {(deal?.nextFollowAt || (!dealId && person?.nextFollowAt)) && (
                <>
                  <small className="muted">
                    {formatShortDateTime(deal?.nextFollowAt || person?.nextFollowAt)}
                  </small>
                  <button
                    type="button"
                    className="deal-follow-chip"
                    onClick={async () => {
                      setBusy('follow');
                      try {
                        if (dealId) {
                          const r = await api(`/deals/${dealId}`, {
                            method: 'PATCH',
                            body: { nextFollowAt: null },
                          });
                          setTimeline((tl) => (tl ? { ...tl, deal: r.deal } : tl));
                          try {
                            window.dispatchEvent(new CustomEvent('zm-deal', { detail: { dealId, reason: 'follow', deal: r.deal } }));
                          } catch { /* ignore */ }
                        } else if (person?.id) {
                          const r = await api(`/contact-persons/${person.id}`, {
                            method: 'PATCH',
                            body: { nextFollowAt: null },
                          });
                          setPerson(r.person);
                        }
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    清除
                  </button>
                </>
              )}
            </div>
            {!dealId && (
              <small className="muted">认领客户后，跟进日进入成交管线与今日待办</small>
            )}
          </div>
        )}

        {person && (
          <div className="customer-sec">
            <div className="customer-section-title">客户标签</div>
            <div className="contact-tag-picks compact">
              {(person.tags || []).map((t) => (
                <button key={t.id} type="button" className="chip-tag on" style={{ '--tag-c': t.color }} onClick={() => toggleTag(t.id, true)}>
                  <span className="label-dot" style={{ background: t.color }} />
                  {t.name}
                </button>
              ))}
              {tagCatalog.filter((t) => !tagIds.has(t.id)).slice(0, 6).map((t) => (
                <button key={t.id} type="button" className="chip-tag" style={{ '--tag-c': t.color }} onClick={() => toggleTag(t.id, false)}>
                  <Plus size={10} /> {t.name}
                </button>
              ))}
            </div>
            {!tagCatalog.length && onOpenContacts && (
              <button type="button" className="btn-ghost xs" onClick={onOpenContacts}>去设置管理客户标签</button>
            )}
          </div>
        )}

        {person && (
          <div className="customer-sec">
            <div className="customer-section-title">邮箱</div>
            <ul className="contact-addr-list compact">
              {(person.addresses || []).map((a) => (
                <li key={a.address}>
                  <span className="addr">{a.address}</span>
                  {a.isPrimary && <em className="pill">主要</em>}
                </li>
              ))}
            </ul>
            <form className="glossary-add compact" onSubmit={addAlias}>
              <input value={addrInput} onChange={(e) => setAddrInput(e.target.value)} placeholder="添加邮箱地址" />
              <button type="submit" className="btn-ghost xs" disabled={busy === 'addr' || !addrInput.trim()}>添加</button>
            </form>
          </div>
        )}

        <div className="customer-sec">
          <div className="customer-section-title">快捷操作</div>
          <div className="customer-actions">
            {(info?.rule || person?.rule) ? (
              <button type="button" className="sl-btn" onClick={() => onRule?.((info?.rule || person?.rule).key, null)}>
                {vip ? <><Crown size={12} /> 取消 VIP</> : <><Bell size={12} /> 取消静音</>}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="sl-btn vip"
                  onClick={() => onRule?.(suggest?.key || target || info.address, 'vip', info.company?.name || person?.company)}
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
            {onOpenContacts && (
              <button type="button" className="sl-btn" onClick={onOpenContacts}>联系人库</button>
            )}
          </div>
          {suggest && !vip && (
            <div className="vip-suggest">
              <Crown size={12} />
              <span>建议设为 VIP：{(suggest.reasons || []).join(' · ')}</span>
            </div>
          )}
        </div>

        <div className="customer-sec customer-timeline-sec">
          <div className="customer-section-title">客户时间线</div>
          {loading && !(timeline?.items?.length || recent.length) && (
            <div className="customer-skel" aria-busy="true" aria-label="加载中">
              <div className="skel-line" />
              <div className="skel-line short" />
              <div className="skel-line" />
            </div>
          )}
          {!loading && !(timeline?.items?.length || recent.length) && (
            <small className="muted">暂无足够的往来记录</small>
          )}
          <ul className="customer-timeline">
            {(timeline?.items || []).map((it) =>
              it.type === 'deal_event' ? (
                <li key={it.id} className="ctl-item event">
                  <span className="ctl-dot event" />
                  <div className="ctl-body">
                    <b>
                      {EVENT_LABEL[it.action] || it.action}
                      {it.detail ? ` · ${it.detail}` : ''}
                    </b>
                    <small>
                      {it.actor?.name || ''} · {it.date ? formatListDate(it.date) : ''}
                    </small>
                  </div>
                </li>
              ) : (
                <li key={'m' + it.id} className={'ctl-item mail ' + (it.direction || '')}>
                  <span className={'ctl-dot ' + (it.direction || 'in')} />
                  <button
                    type="button"
                    className="ctl-body as-btn"
                    onClick={() => onOpenThread?.(it.id)}
                  >
                    <b>
                      {it.direction === 'out' ? <ArrowUpRight size={11} /> : <ArrowDownLeft size={11} />}
                      {it.direction === 'out' ? '你发出' : '对方来信'} · {it.subject}
                    </b>
                    <small>
                      {it.date ? formatListDate(it.date) : ''}
                      {it.snippet ? ` · ${it.snippet}` : ''}
                    </small>
                  </button>
                </li>
              )
            )}
            {!timeline?.items?.length &&
              recent.map((r, i) => (
                <li key={r.id || i} className="ctl-item mail">
                  <span className="ctl-dot in" />
                  <button type="button" className="ctl-body as-btn" onClick={() => r.id && onOpenThread?.(r.id)} disabled={!r.id}>
                    <b>{r.subject}</b>
                    <small>{r.date ? formatListDate(r.date) : ''}</small>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
