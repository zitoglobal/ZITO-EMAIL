import React, { useEffect, useRef, useState } from 'react';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Star, Mail, Sparkles, Languages, Paperclip, Download, ArrowLeft, Loader2,
  AlertTriangle, CheckCircle2, ListChecks, FolderInput, Eye, Clock, Pin, ShieldAlert, ShieldCheck, MoreHorizontal, ImageOff,
  BellOff, Send, Maximize2, FileText, Printer, Crown, Bell, Hourglass,
} from 'lucide-react';
import { api } from '../api.js';
import {
  addrString, avatarColor, displayName, folderLabel, formatFullDate, formatListDate, formatSize, hasRemoteImages, initials,
  relativeTime, replyIdeas, snoozePresets, sortFolders, textToHtml, waitText,
} from '../utils.js';
import { buildComposeState, signatureHtml, toPayload } from '../compose.js';
import MailFrame from './MailFrame.jsx';
import { BrandSymbol } from './Brand.jsx';
import TimeMenu from './TimeMenu.jsx';

const URGENCY = { high: ['紧急', 'high'], medium: ['一般', 'medium'], low: ['不急', 'low'] };
const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

function SenderLine({ info, onRule }) {
  if (!info || info.tier === 'self' || info.tier === 'bulk') return null;
  const vip = info.rule?.kind === 'vip';
  const muted = info.rule?.kind === 'muted';
  const target = info.company?.domain ? '@' + info.company.domain : null;
  return (
    <div className="sender-line">
      {TIER_TEXT[info.tier] && <span className={'tag tier-' + info.tier}>{info.tier === 'vip' && <Crown size={10} />} {TIER_TEXT[info.tier]}</span>}
      {info.company?.domain && <span className="sl-item">{info.company.name}</span>}
      <span className="sl-item">来信 {info.received} 封</span>
      {info.sent > 0 && <span className="sl-item">你发过 {info.sent} 封</span>}
      {info.lastSent && <span className="sl-item">上次给 TA 发信 {relativeTime(info.lastSent)}</span>}
      <span className="spacer" />
      {info.rule ? (
        <button className="sl-btn" onClick={() => onRule(info.rule.key, null)} title={`规则：${info.rule.key}`}>
          {vip ? <><Crown size={12} /> 取消 VIP</> : <><Bell size={12} /> 取消静音</>}
        </button>
      ) : (
        <>
          <button className="sl-btn vip" onClick={() => onRule(target || info.address, 'vip', info.company?.name)} title={target ? `把 ${target} 的所有来信设为 VIP` : '设为 VIP 客户'}>
            <Crown size={12} /> 设为 VIP{target ? '（整个公司）' : ''}
          </button>
          {!muted && (
            <button className="sl-btn" onClick={() => onRule(info.address, 'muted')} title="此发件人的邮件不再进入今日待办">
              <BellOff size={12} /> 静音
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Attachments({ msg }) {
  if (!msg.attachments?.length) return null;
  return (
    <div className="attachments">
      <div className="att-title"><Paperclip size={14} /> {msg.attachments.length} 个附件</div>
      <div className="att-list">
        {msg.attachments.map((a) => {
          const base = `/api/messages/${msg.id}/attachments/${a.index}`;
          const previewable = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i.test(a.contentType || '');
          return (
            <div key={a.index} className="att">
              <div className="att-icon">{(a.filename.split('.').pop() || 'file').slice(0, 4).toUpperCase()}</div>
              <div className="att-info">
                <div className="att-name" title={a.filename}>{a.filename}</div>
                <div className="att-size">{formatSize(a.size)}</div>
              </div>
              {previewable && (
                <a className="icon-btn" href={base + '?inline=1'} target="_blank" rel="noreferrer" title="预览"><Eye size={15} /></a>
              )}
              <a className="icon-btn" href={base} title="下载"><Download size={15} /></a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageCard({ item, detail, expanded, onToggle, settings, dark, isLast, primary, onCompose, mailbox, onRule }) {
  const [allowImages, setAllowImages] = useState(false);
  const loading = expanded && !detail;
  const isDraft = item.specialUse === '\\Drafts';

  if (!expanded) {
    return (
      <div className={'thread-card collapsed' + (item.seen ? '' : ' unread')} onClick={onToggle}>
        <div className="avatar sm" style={{ background: avatarColor(item.from?.address) }}>{initials(item.from)}</div>
        <b className="tc-from">{displayName(item.from)}</b>
        {isDraft && <span className="draft-tag">草稿</span>}
        <span className="tc-snippet">{item.snippet}</span>
        <span className="tc-date">{formatListDate(item.date)}</span>
      </div>
    );
  }

  const m = detail && !detail.error ? detail : null;
  const images = m && hasRemoteImages(m.html);
  const autoAllow = settings.remoteImages === 'always' || (settings.remoteImages === 'contacts' && m?.knownSender);
  const showImages = autoAllow || allowImages;

  return (
    <div className="thread-card">
      <div className="mail-meta" onClick={isLast ? undefined : onToggle}>
        <div className="avatar lg" style={{ background: avatarColor(item.from?.address) }}>{initials(item.from)}</div>
        <div className="meta-text">
          <div className="meta-from">
            <b>{displayName(item.from)}</b> <span>&lt;{item.from?.address}&gt;</span>
            {isDraft && <span className="draft-tag">草稿</span>}
          </div>
          <div className="meta-to">
            收件人：{(m?.to || item.to || []).map(addrString).join('、') || '—'}
            {(m?.cc || item.cc || []).length > 0 && <> · 抄送：{(m?.cc || item.cc).map(addrString).join('、')}</>}
            {m?.bcc?.length > 0 && <> · 密送：{m.bcc.map(addrString).join('、')}</>}
          </div>
          {m?.replyTo?.length > 0 && m.replyTo[0].address !== item.from?.address && (
            <div className="meta-to">回复至：{m.replyTo.map(addrString).join('、')}</div>
          )}
        </div>
        <div className="meta-side">
          <div className="meta-date" title={formatFullDate(item.date)}>{formatFullDate(item.date)}</div>
          {mailbox && <div className="meta-mb"><span className="mb-dot" style={{ background: mailbox.color }} />{mailbox.email}</div>}
        </div>
      </div>
      {m && primary && <SenderLine info={m.sender && { ...m.sender, address: item.from?.address }} onRule={onRule} />}

      {loading && <div className="reader-loading sm"><Loader2 size={16} className="spin" /> 正在加载…</div>}
      {detail?.error && <div className="list-error">{detail.error}</div>}
      {m && (
        <>
          {images && !showImages && (
            <div className="img-bar">
              <ImageOff size={14} /> 为保护隐私，已阻止加载外部图片（可防止发件人追踪你是否阅读）
              <button className="link-btn" onClick={() => setAllowImages(true)}>显示图片</button>
            </div>
          )}
          {isDraft ? (
            <div className="draft-box">
              <MailFrame html={m.html} text={m.text} dark={dark} allowImages={showImages} />
              <button className="btn-ghost sm" onClick={() => onCompose('draft', m)}><FileText size={14} /> 继续编辑草稿</button>
            </div>
          ) : (
            <MailFrame html={m.html} text={m.text} dark={dark} allowImages={showImages} collapseQuotes />
          )}
          <Attachments msg={m} />
          {!isLast && !isDraft && (
            <div className="card-actions">
              <button onClick={() => onCompose('reply', m)}><Reply size={14} /> 回复</button>
              <button onClick={() => onCompose('forward', m)}><Forward size={14} /> 转发</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Reader({
  id, listItem, settings, aiEnabled, dark, mailboxMap, folders, composeCtx, onCompose, onAction, onSend, onBack, notify, onLoaded, onFollowUp,
}) {
  const [thread, setThread] = useState(null);
  const [details, setDetails] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [translated, setTranslated] = useState(null);
  const [showTranslated, setShowTranslated] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [menu, setMenu] = useState(null);
  const [quick, setQuick] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const alive = useRef(0);
  const scroller = useRef();

  const msg = details[id] && !details[id].error ? details[id] : null;
  const base = msg || listItem;

  function loadDetail(mid, token) {
    return api(`/messages/${mid}`)
      .then((d) => token === alive.current && setDetails((s) => ({ ...s, [mid]: d })))
      .catch((e) => token === alive.current && setDetails((s) => ({ ...s, [mid]: { error: e.message } })));
  }

  useEffect(() => {
    if (!id) return;
    const token = ++alive.current;
    setThread(null);
    setDetails({});
    setSummary(null);
    setTranslated(null);
    setShowTranslated(false);
    setMenu(null);
    setQuick('');
    setExpanded(new Set([id]));
    scroller.current?.scrollTo(0, 0);

    loadDetail(id, token);
    if (settings.conversationView !== false) {
      api(`/messages/${id}/thread`)
        .then(({ messages }) => {
          if (token !== alive.current) return;
          setThread(messages);
          const last = messages[messages.length - 1];
          const open = new Set([id]);
          if (last) open.add(last.id);
          messages.forEach((m) => !m.seen && open.add(m.id));
          setExpanded(open);
          open.forEach((mid) => mid !== id && loadDetail(mid, token));
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const threadCount = listItem?.threadCount;
  useEffect(() => {
    if (!id || !thread || settings.conversationView === false || !threadCount || threadCount === thread.length) return;
    const token = alive.current;
    api(`/messages/${id}/thread`)
      .then(({ messages }) => {
        if (token !== alive.current) return;
        const known = new Set(thread.map((m) => m.id));
        const added = messages.filter((m) => !known.has(m.id)).map((m) => m.id);
        setThread(messages);
        if (added.length) {
          setExpanded((s) => new Set([...s, ...added]));
          added.forEach((mid) => loadDetail(mid, token));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadCount]);

  useEffect(() => {
    if (msg) onLoaded?.(msg);
    if (msg && aiEnabled && settings.autoSummary && !summary && !summaryLoading) runSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.id]);

  useEffect(() => {
    if (!thread || thread.length < 2) return;
    const el = document.querySelector(`.thread-slot[data-mid="${id}"]`);
    if (el && thread[thread.length - 1].id !== id) el.scrollIntoView({ block: 'start' });
  }, [thread, id]);

  async function runSummary() {
    if (!id) return;
    setSummaryLoading(true);
    try {
      setSummary(await api('/ai/summarize', { method: 'POST', body: { id } }));
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSummaryLoading(false);
    }
  }

  async function runTranslate() {
    if (translated) return setShowTranslated((v) => !v);
    setTranslating(true);
    try {
      setTranslated(await api('/ai/translate', { method: 'POST', body: { id, target: '简体中文' } }));
      setShowTranslated(true);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setTranslating(false);
    }
  }

  function toggleCard(mid) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(mid)) n.delete(mid);
      else {
        n.add(mid);
        if (!details[mid]) loadDetail(mid, alive.current);
      }
      return n;
    });
  }

  async function setRule(key, kind, name) {
    try {
      if (kind) await api('/sender-rules', { method: 'POST', body: { key, kind, name } });
      else await api('/sender-rules?key=' + encodeURIComponent(key), { method: 'DELETE' });
      notify(kind === 'vip' ? `已设为 VIP 客户：${key}` : kind === 'muted' ? `已静音 ${key}，其来信不再进入今日待办` : '已移除规则');
      loadDetail(id, alive.current);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function sendQuick() {
    if (!quick.trim() || !msg) return;
    const state = buildComposeState('reply', msg, composeCtx);
    const mb = mailboxMap[state.mailboxId];
    const bodyHtml = `<div>${textToHtml(quick.trim())}</div><br>${signatureHtml(mb?.signature)}`;
    setQuickBusy(true);
    try {
      await onSend(toPayload(state, bodyHtml), [], { ...state, body: bodyHtml });
      setQuick('');
    } finally {
      setQuickBusy(false);
    }
  }

  if (!id) {
    return (
      <section className="reader-pane empty-reader">
        <div className="empty-illustration">
          <BrandSymbol size={84} />
          <p>选一封邮件，开始处理</p>
          <small>最紧急的客户来信已经排在最上面</small>
          <div className="kbd-row">
            <span><kbd>Ctrl</kbd> <kbd>K</kbd> 搜索与命令</span>
            <span><kbd>J</kbd> <kbd>K</kbd> 上下切换</span>
            <span><kbd>R</kbd> 回复</span>
            <span><kbd>D</kbd> 已处理</span>
            <span><kbd>?</kbd> 全部快捷键</span>
          </div>
        </div>
      </section>
    );
  }

  const special = base?.specialUse;
  const inJunk = special === '\\Junk';
  const inTrash = special === '\\Trash';
  const threadIds = (thread || [])
    .filter((m) => m.mailboxId === base?.mailboxId && m.folder === base?.folder)
    .map((m) => m.id);
  const groupIds = threadIds.length ? threadIds : [id];
  const items = settings.conversationView !== false && thread?.length ? thread : base ? [{ ...base, id }] : [];
  const mbFolders = sortFolders(folders[base?.mailboxId] || []).filter((f) => f.path !== base?.folder);
  const mailbox = mailboxMap[base?.mailboxId];
  const multi = Object.keys(mailboxMap).length > 1;
  const act = (action, extra) => {
    setMenu(null);
    onAction(['archive', 'trash', 'spam', 'notspam', 'read', 'unread', 'delete'].includes(action) ? groupIds : [id], action, extra);
  };

  return (
    <section className="reader-pane">
      <div className="reader-toolbar">
        <button className="icon-btn mobile-only" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="tb-group">
          <button className="tb" onClick={() => onCompose('reply', msg)} disabled={!msg} title="回复 (R)"><Reply size={16} /><span>回复</span></button>
          <button className="tb" onClick={() => onCompose('replyAll', msg)} disabled={!msg} title="全部回复 (A)"><ReplyAll size={16} /><span>全部回复</span></button>
          <button className="tb" onClick={() => onCompose('forward', msg)} disabled={!msg} title="转发 (F)"><Forward size={16} /><span>转发</span></button>
        </div>
        <div className="tb-group">
          {(listItem?.awaiting || listItem?._section === 'reply') && (
            <button className="tb icon" onClick={() => act('done')} title="已处理，无需回复 (D)"><CheckCircle2 size={16} /></button>
          )}
          {special !== '\\Archive' && special !== '\\All' && (
            <button className="tb icon" onClick={() => act('archive')} title="归档 (E)"><Archive size={16} /></button>
          )}
          <button className="tb icon" onClick={() => act(inTrash ? 'delete' : 'trash')} title={inTrash ? '彻底删除' : '删除 (#)'}><Trash2 size={16} /></button>
          {inJunk ? (
            <button className="tb icon" onClick={() => act('notspam')} title="不是垃圾邮件"><ShieldCheck size={16} /></button>
          ) : (
            <button className="tb icon" onClick={() => act('spam')} title="举报垃圾邮件 (!)"><ShieldAlert size={16} /></button>
          )}
          <div className="move-wrap">
            <button className={'tb icon' + (base?.snoozeUntil ? ' active' : '')} onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')} title="稍后提醒 (B)">
              <Clock size={16} />
            </button>
            {menu === 'snooze' && (
              <TimeMenu
                title={base?.snoozeUntil ? '修改提醒时间' : '稍后提醒'}
                presets={snoozePresets()}
                className="right"
                onClose={() => setMenu(null)}
                onPick={(t) => act('snooze', { until: t })}
              />
            )}
          </div>
          <button className="tb icon" onClick={() => act('unread')} title="标为未读 (U)"><Mail size={16} /></button>
          <button className={'tb icon' + (base?.flagged ? ' starred' : '')} onClick={() => act(base?.flagged ? 'unflag' : 'flag')} title="星标 (S)">
            <Star size={16} />
          </button>
          <button className={'tb icon' + (base?.pinned ? ' active' : '')} onClick={() => act(base?.pinned ? 'unpin' : 'pin')} title="置顶 (P)">
            <Pin size={16} />
          </button>
          <div className="move-wrap">
            <button className="tb icon" onClick={() => setMenu(menu === 'move' ? null : 'move')} title="移动到 (V)"><FolderInput size={16} /></button>
            {menu === 'move' && (
              <div className="dropdown right scroll" onMouseLeave={() => setMenu(null)}>
                <div className="dropdown-title">移动到</div>
                {mbFolders.map((f) => (
                  <button key={f.path} onClick={() => act('move', { dest: f.path })}>{folderLabel(f)}</button>
                ))}
              </div>
            )}
          </div>
          <div className="move-wrap">
            <button className="tb icon" onClick={() => setMenu(menu === 'more' ? null : 'more')} title="更多"><MoreHorizontal size={16} /></button>
            {menu === 'more' && (
              <div className="dropdown right" onMouseLeave={() => setMenu(null)}>
                {base?.snoozeUntil && <button onClick={() => act('unsnooze')}><Clock size={13} /> 取消稍后提醒</button>}
                <a href={`/api/messages/${id}/raw`} onClick={() => setMenu(null)}><Download size={13} /> 下载原始邮件 (.eml)</a>
                <button onClick={() => { setMenu(null); window.print(); }}><Printer size={13} /> 打印</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="reader-scroll" ref={scroller}>
        {!base && <div className="reader-loading"><Loader2 size={22} className="spin" /> 正在加载邮件…</div>}
        {details[id]?.error && !thread && <div className="list-error">{details[id].error}</div>}
        {base && (
          <article className="mail-article">
            <h1 className="mail-subject">
              {(showTranslated && translated?.subject) || base.subject || '(无主题)'}
              {items.length > 1 && <span className="subject-count">{items.length}</span>}
            </h1>
            <div className="subject-tags">
              {multi && mailbox && (
                <span className="mb-chip" style={{ '--c': mailbox.color }}>
                  <span className="mb-dot" style={{ background: mailbox.color }} /> {mailbox.name || mailbox.email}
                </span>
              )}
              {base.folder && <span className="folder-chip">{folderLabel((folders[base.mailboxId] || []).find((f) => f.path === base.folder)) || base.folder}</span>}
              {base.snoozeUntil && <span className="folder-chip warn"><Clock size={11} /> {formatFullDate(base.snoozeUntil)} 提醒</span>}
              {msg?.unsubscribe && (
                <button
                  className="folder-chip action"
                  onClick={() => {
                    if (msg.unsubscribe.url) window.open(msg.unsubscribe.url, '_blank', 'noopener,noreferrer');
                    else onCompose('new', null, { to: msg.unsubscribe.mail, subject: 'unsubscribe' });
                  }}
                  title="退订此邮件列表"
                >
                  <BellOff size={11} /> 退订
                </button>
              )}
            </div>

            {listItem?._section === 'reply' && listItem.priority && (
              <div className={'await-banner' + (listItem.priority.overdue ? ' over' : '')}>
                <Hourglass size={15} />
                <div>
                  <b>{listItem.priority.overdue ? '已超过回复时限' : '等待你回复'} · 已等 {waitText(listItem.priority.waitingHours)}</b>
                  <small>{listItem.priority.reasons.join(' · ')}</small>
                </div>
                <button className="btn-ghost sm" onClick={() => act('done')}><CheckCircle2 size={13} /> 无需回复</button>
                <button className="btn-primary sm" onClick={() => onCompose('reply', msg)} disabled={!msg}><Reply size={13} /> 回复</button>
              </div>
            )}
            {listItem?._section === 'follow' && listItem.follow && (
              <div className="await-banner follow">
                <Send size={15} />
                <div>
                  <b>你在 {listItem.follow.days} 天前发出，{displayName(listItem.follow.to)} 还没有回复</b>
                  <small>适时跟进能显著提高成单率</small>
                </div>
                <button className="btn-ghost sm" onClick={() => act('nofollow')}><BellOff size={13} /> 无需跟进</button>
                <button className="btn-primary sm" onClick={() => onFollowUp?.(listItem)}><Reply size={13} /> 写跟进</button>
              </div>
            )}

            {aiEnabled && (
              <div className="ai-bar">
                <button className="ai-btn" onClick={runSummary} disabled={summaryLoading || !msg}>
                  {summaryLoading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                  {summary ? '重新分析' : items.length > 1 ? 'AI 总结会话' : 'AI 摘要'}
                </button>
                <button className="ai-btn ghost" onClick={runTranslate} disabled={translating || !msg}>
                  {translating ? <Loader2 size={14} className="spin" /> : showTranslated ? <Eye size={14} /> : <Languages size={14} />}
                  {showTranslated ? '查看原文' : '翻译成中文'}
                </button>
                <button className="ai-btn ghost" onClick={() => onCompose('reply', msg, { aiInstruction: '根据邮件内容给出合适回复' })} disabled={!msg}>
                  <Reply size={14} /> AI 智能回复
                </button>
              </div>
            )}

            {summary && (
              <div className="ai-card">
                <div className="ai-card-head">
                  <Sparkles size={15} /> AI 摘要
                  {summary.category && <span className="pill">{summary.category}</span>}
                  {URGENCY[summary.urgency] && <span className={'pill urgency ' + URGENCY[summary.urgency][1]}>{URGENCY[summary.urgency][0]}</span>}
                </div>
                <p className="ai-summary">{summary.summary}</p>
                {summary.keyPoints?.length > 0 && (
                  <ul className="ai-points">
                    {summary.keyPoints.map((p, i) => <li key={i}><CheckCircle2 size={13} /> {p}</li>)}
                  </ul>
                )}
                {summary.actionItems?.length > 0 && (
                  <div className="ai-actions">
                    <div className="ai-sub"><ListChecks size={14} /> 待办事项</div>
                    <ul>{summary.actionItems.map((p, i) => <li key={i}><AlertTriangle size={12} /> {p}</li>)}</ul>
                  </div>
                )}
                {summary.quickReplies?.length > 0 && (
                  <div className="quick-replies">
                    <div className="ai-sub">一键回复</div>
                    <div className="qr-list">
                      {summary.quickReplies.map((r, i) => (
                        <button key={i} onClick={() => onCompose('reply', msg, { aiInstruction: r })}>{r}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {showTranslated && translated ? (
              <div className="translated-body">
                <div className="translated-tag"><Languages size={13} /> AI 翻译</div>
                <MailFrame text={translated.body} dark={dark} />
              </div>
            ) : (
              <div className="thread">
                {items.map((it, i) => (
                  <div key={it.id} data-mid={it.id} className="thread-slot">
                    <MessageCard
                      item={it}
                      detail={details[it.id]}
                      expanded={expanded.has(it.id)}
                      onToggle={() => toggleCard(it.id)}
                      settings={settings}
                      dark={dark}
                      isLast={i === items.length - 1}
                      primary={it.id === id}
                      onCompose={onCompose}
                      onRule={setRule}
                      mailbox={mailboxMap[it.mailboxId]}
                    />
                  </div>
                ))}
              </div>
            )}

            {msg && special !== '\\Drafts' && (
              <div className="quick-reply">
                <div className="avatar sm" style={{ background: mailbox?.color || 'var(--accent)' }}>{initials({ name: mailbox?.name, address: mailbox?.email })}</div>
                <div className="qr-box">
                  <div className="reply-ideas">
                    {replyIdeas(listItem?.priority?.signals || listItem?.follow?.signals || listItem?.signals).map((idea) => (
                      <button key={idea.label} className={quick.startsWith(idea.body.slice(0, 24)) ? 'on' : ''} onClick={() => setQuick(idea.body)} title={idea.body}>
                        {idea.label}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={quick}
                    onChange={(e) => setQuick(e.target.value)}
                    placeholder={`快速回复 ${displayName(msg.from)}…（Ctrl+Enter 发送）`}
                    rows={quick ? 4 : 1}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        sendQuick();
                      }
                      e.stopPropagation();
                    }}
                  />
                  {quick && (
                    <div className="qr-actions">
                      <small>将以 {mailbox?.email} 发送，自动附带签名与引用</small>
                      <button className="btn-ghost sm" onClick={() => onCompose('reply', msg, { body: `<div>${textToHtml(quick)}</div><br>${signatureHtml(mailbox?.signature)}` })}>
                        <Maximize2 size={13} /> 完整编辑
                      </button>
                      <button className="btn-primary sm" onClick={sendQuick} disabled={quickBusy}>
                        {quickBusy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} 发送
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {msg && special !== '\\Drafts' && !quick && (
              <div className="reply-shortcuts">
                <button onClick={() => onCompose('reply', msg)}><Reply size={15} /> 回复</button>
                <button onClick={() => onCompose('replyAll', msg)}><ReplyAll size={15} /> 全部回复</button>
                <button onClick={() => onCompose('forward', msg)}><Forward size={15} /> 转发</button>
              </div>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
