import React, { useEffect, useRef, useState } from 'react';
import { X, Crown, Bell, BellOff, Hourglass, Users, Reply, Clock, Plus, Loader2, UserPlus, CalendarClock } from 'lucide-react';
import { api } from '../api.js';
import { avatarColor, displayName, formatListDate, formatShortDateTime, initials, relativeTime, waitText } from '../utils.js';

const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

/** 客户栏 / 抽屉：Person 主数据 + sender_rules + 最近线程 */
export default function CustomerPanel({
  address,
  sender,
  slaHours,
  listItem,
  onRule,
  onOpenThread,
  onClose,
  onOpenContacts,
  mode = 'rail', // rail | drawer
}) {
  const [recent, setRecent] = useState(sender?.recentSubjects || []);
  const [loading, setLoading] = useState(false);
  const [person, setPerson] = useState(null);
  const [auto, setAuto] = useState(null);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [note, setNote] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [addrInput, setAddrInput] = useState('');
  const [busy, setBusy] = useState('');
  const noteTimer = useRef(null);

  const info = sender && { ...sender, address: address || sender.address };
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
  const empty = !info?.address;

  useEffect(() => {
    setRecent(sender?.recentSubjects || []);
  }, [sender]);

  useEffect(() => {
    if (!info?.address) {
      setRecent([]);
      setPerson(null);
      setAuto(null);
      setNote('');
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api('/contact-persons/resolve?address=' + encodeURIComponent(info.address))
      .then((d) => {
        if (!alive) return;
        setPerson(d.person || null);
        setAuto(d.auto || null);
        setNote(d.person?.note || '');
        if (d.recent?.length) {
          setRecent(d.recent);
        }
      })
      .catch(() => {
        if (!alive) return;
        setPerson(null);
      })
      .finally(() => alive && setLoading(false));

    api('/contact-tags')
      .then((d) => alive && setTagCatalog(d.tags || []))
      .catch(() => {});

    // 若 resolve 无 recent，回退单地址搜索
    api('/messages' + `?q=${encodeURIComponent('from:' + info.address)}&limit=5`)
      .then((d) => {
        if (!alive) return;
        setRecent((prev) => {
          if (prev?.length) return prev;
          return (d.messages || []).slice(0, 5).map((m) => ({
            id: m.id,
            subject: m.subject || '(无主题)',
            date: m.date,
          }));
        });
      })
      .catch(() => {});

    return () => {
      alive = false;
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, [info?.address]);

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
  const waitingOnThem = !!listItem?.waitingOnThem;
  const needReply = listItem?._section === 'reply';
  const followUp = listItem?._section === 'follow';
  const effectiveSla = slaHours ?? priority?.slaHours;
  const showStatus = !empty && listItem && (waitingOnThem || needReply || followUp || priority?.overdue || effectiveSla != null || listItem?.remindStage >= 1);
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
            <small>从左侧点开一封邮件，这里会显示公司、跟进状态、VIP 与最近往来——选信只换内容，栏位保持不动。</small>
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
            <div className="customer-section-title" style={{ marginTop: 10 }}>
              <CalendarClock size={12} /> 下次跟进
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
                      const r = await api(`/contact-persons/${person.id}`, {
                        method: 'PATCH',
                        body: { nextFollowAt: d.getTime() },
                      });
                      setPerson(r.person);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {n === 1 ? '明天' : n === 3 ? '3 天' : '一周'}
                </button>
              ))}
              {person.nextFollowAt && (
                <>
                  <small className="muted">{formatShortDateTime(person.nextFollowAt)}</small>
                  <button
                    type="button"
                    className="deal-follow-chip"
                    onClick={async () => {
                      setBusy('follow');
                      try {
                        const r = await api(`/contact-persons/${person.id}`, {
                          method: 'PATCH',
                          body: { nextFollowAt: null },
                        });
                        setPerson(r.person);
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
