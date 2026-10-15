import React, { useEffect, useRef, useState } from 'react';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Star, Mail, Sparkles, Languages, Paperclip, Download, ArrowLeft, Loader2,
  AlertTriangle, CheckCircle2, ListChecks, FolderInput, Eye, Clock, Pin, ShieldAlert, ShieldCheck, MoreHorizontal, ImageOff,
  BellOff, Send, Maximize2, FileText, Printer, Crown, Bell, Hourglass,
} from 'lucide-react';
import { api } from '../api.js';
import {
  addrString, avatarColor, detectMailLang, displayName, folderLabel, formatFullDate, formatListDate, formatSize, hasRemoteImages, initials,
  mostlyChinese, normalizeTranslateTarget, relativeTime, replyIdeas, smartReplyInstruction, snoozePresets, sortFolders,
  sourceMatchesTarget, summaryFromAiNote, textToHtml, waitText,
} from '../utils.js';
import { buildComposeState, signatureHtml, toPayload } from '../compose.js';
import MailFrame from './MailFrame.jsx';
import { BrandSymbol } from './Brand.jsx';
import TimeMenu from './TimeMenu.jsx';

const URGENCY = { high: ['紧急', 'high'], medium: ['一般', 'medium'], low: ['不急', 'low'] };
const TIER_TEXT = { vip: 'VIP 客户', customer: '老客户', new: '新联系人', colleague: '同事', muted: '已静音', bulk: '' };

function RelationCard({ info, onRule, slaHours }) {
  if (!info || info.tier === 'self' || info.tier === 'bulk') return null;
  const vip = info.rule?.kind === 'vip';
  const muted = info.rule?.kind === 'muted';
  const target = info.company?.domain ? '@' + info.company.domain : null;
  const recent = info.recentSubjects || [];
  const suggest = info.vipSuggest;
  return (
    <div className="relation-card">
      <div className="relation-card-main">
        <div className="relation-card-badges">
          {TIER_TEXT[info.tier] && (
            <span className={'tag tier-' + info.tier}>{info.tier === 'vip' && <Crown size={10} />} {TIER_TEXT[info.tier]}</span>
          )}
          {slaHours != null && ['vip', 'customer', 'new'].includes(info.tier) && (
            <span className="relation-sla" title="该层级的回复时限"><Hourglass size={11} /> SLA {slaHours}h</span>
          )}
          {info.company?.domain && <span className="relation-co">{info.company.name} · {info.company.domain}</span>}
        </div>
        <div className="relation-card-stats sender-line">
          <span className="sl-item">来信 {info.received} 封</span>
          {info.sent > 0 && <span className="sl-item">你发过 {info.sent} 封</span>}
          {info.lastSent && <span className="sl-item">上次给 TA 发信 {relativeTime(info.lastSent)}</span>}
        </div>
        {recent.length > 0 && (
          <div className="relation-recent" title="最近往来主题">
            {recent.map((r, i) => (
              <span key={i} className="relation-topic">{r.subject}</span>
            ))}
          </div>
        )}
        {suggest && !vip && (
          <div className="vip-suggest">
            <Crown size={12} />
            <span>建议设为 VIP：{(suggest.reasons || []).join(' · ')}</span>
            <button
              type="button"
              className="sl-btn vip"
              onClick={() => onRule(suggest.key || target || info.address, 'vip', info.company?.name)}
              title="确认后按 VIP SLA 优先分诊，不会自动升级"
            >
              确认 VIP
            </button>
          </div>
        )}
      </div>
      <div className="relation-card-actions">
        {info.rule ? (
          <button className="sl-btn" onClick={() => onRule(info.rule.key, null)} title={`规则：${info.rule.key}`}>
            {vip ? <><Crown size={12} /> 取消 VIP</> : <><Bell size={12} /> 取消静音</>}
          </button>
        ) : (
          <>
            {!suggest && (
              <button className="sl-btn vip" onClick={() => onRule(target || info.address, 'vip', info.company?.name)} title={target ? `把 ${target} 的所有来信设为 VIP` : '设为 VIP 客户'}>
                <Crown size={12} /> 设为 VIP{target ? '（公司）' : ''}
              </button>
            )}
            {!muted && (
              <button className="sl-btn" onClick={() => onRule(info.address, 'muted')} title="此发件人的邮件不再进入今日待办">
                <BellOff size={12} /> 静音
              </button>
            )}
          </>
        )}
      </div>
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

function MessageCard({ item, detail, expanded, onToggle, settings, dark, isLast, primary, onCompose, mailbox, onRule, slaHours }) {
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
      {m && primary && <RelationCard info={m.sender && { ...m.sender, address: item.from?.address }} onRule={onRule} slaHours={slaHours} />}

      {loading && <div className="reader-loading sm"><Loader2 size={16} className="spin" /> 正在加载…</div>}
      {detail?.error && <div className="list-error">{detail.error}</div>}
      {m && (
        <>
          {images && !showImages && (
            <div className="img-bar img-bar-risk">
              <ImageOff size={14} />
              <span className="img-bar-copy">
                外部图片已拦截：加载后发件人可能得知你已读（追踪像素）。确认安全后再显示。
              </span>
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
  id, listItem, settings, aiEnabled, dark, mailboxMap, folders, composeCtx, onCompose, onAction, onSend, onBack, notify, onLoaded, onFollowUp, onAiNote,
}) {
  const [thread, setThread] = useState(null);
  const [details, setDetails] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [translated, setTranslated] = useState(null);
  const [showTranslated, setShowTranslated] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [lastTranslateTarget, setLastTranslateTarget] = useState(null);
  const [menu, setMenu] = useState(null);
  const [quick, setQuick] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [pinning, setPinning] = useState(false);
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
    setLastTranslateTarget(null);
    setMenu(null);
    setQuick('');
    setPinning(false);
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
    if (!msg) return;
    const cached = summaryFromAiNote(msg.aiNote);
    if (cached && !summary) {
      setSummary(cached);
      return;
    }
    if (aiEnabled && settings.autoSummary && !summary && !summaryLoading && !msg.aiNote?.summary) runSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.id]);

  useEffect(() => {
    if (!msg || !aiEnabled || !settings.autoTranslate || translated || translating) return;
    const target = resolveTranslateTarget();
    if (sourceMatchesTarget(detectMailLang(mailPlainText()), target)) return;
    runTranslate(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.id, aiEnabled, settings.autoTranslate]);

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

  function mailPlainText() {
    if (!msg) return listItem?.snippet || '';
    return msg.text || String(msg.html || '').replace(/<[^>]+>/g, ' ') || listItem?.snippet || '';
  }

  function resolveTranslateTarget() {
    const body = mailPlainText();
    const pref = normalizeTranslateTarget(settings.translateTarget);
    // Body mostly ZH → offer English; otherwise use preference (default 简体中文)
    if (mostlyChinese(body)) return 'English';
    return pref;
  }

  function translateButtonLabel() {
    if (translating) return '翻译中…';
    if (translated) return showTranslated ? '查看原文' : '查看翻译';
    return resolveTranslateTarget() === 'English' ? '译成英文' : '译成中文';
  }

  async function runTranslate(forceTarget) {
    if (translated && forceTarget == null) return setShowTranslated((v) => !v);
    const target = forceTarget || resolveTranslateTarget();
    const sourceGuess = detectMailLang(mailPlainText());
    if (sourceMatchesTarget(sourceGuess, target)) {
      notify(target === 'English' ? '原文已是英文，无需翻译' : '原文已是中文，无需翻译');
      return;
    }
    setTranslating(true);
    try {
      const result = await api('/ai/translate', { method: 'POST', body: { id, target } });
      if (result?.sourceLang && sourceMatchesTarget(result.sourceLang, target)) {
        notify(target === 'English' ? '原文已是英文，无需翻译' : '原文已是中文，无需翻译');
      } else if (result?.fromCache) {
        notify('已使用翻译缓存');
      }
      setTranslated(result);
      setLastTranslateTarget(target);
      setShowTranslated(true);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setTranslating(false);
    }
  }

  const noteSource = msg?.aiNote || listItem?.aiNote;
  const isPinned = !!(noteSource?.pinned || noteSource?.summary);

  function openSmartReply(intent = '') {
    if (!msg) return;
    const pack = summary || summaryFromAiNote(noteSource);
    const short = intent || (pack?.summary ? `基于摘要写一封合适回复` : '根据邮件内容给出合适回复');
    onCompose('reply', msg, {
      aiInstruction: short,
      aiContext: smartReplyInstruction(pack, intent),
      openAi: true,
    });
  }

  async function pinSummary() {
    if (!id || !summary?.summary) return;
    setPinning(true);
    try {
      const { aiNote } = await api('/ai/note', {
        method: 'POST',
        body: {
          id,
          note: String(summary.summary).slice(0, 120),
          summary: summary.summary,
          keyPoints: summary.keyPoints,
          actionItems: summary.actionItems,
          urgency: summary.urgency,
          category: summary.category,
          quickReplies: summary.quickReplies,
          replyLanguage: summary.replyLanguage,
          source: 'summarize',
        },
      });
      setDetails((s) => (s[id] ? { ...s, [id]: { ...s[id], aiNote } } : s));
      onAiNote?.(id, aiNote);
      notify('已钉选到今日待办，列表可直接看到要点', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setPinning(false);
    }
  }

  async function unpinSummary() {
    if (!id) return;
    setPinning(true);
    try {
      await api('/ai/note', { method: 'POST', body: { id, clear: true } });
      setDetails((s) => (s[id] ? { ...s, [id]: { ...s[id], aiNote: null } } : s));
      onAiNote?.(id, null);
      notify('已取消钉选');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setPinning(false);
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
              {base.subject || '(无主题)'}
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
                  <small>
                    {listItem.priority.reasons.join(' · ')}
                    {listItem.priority.slaHours != null ? ` · 时限 ${listItem.priority.slaHours}h` : ''}
                  </small>
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
            {!listItem?._section && listItem?.waitingOnThem && (
              <div className="await-banner follow">
                <Hourglass size={15} />
                <div>
                  <b>等对方回复</b>
                  <small>{listItem.waitingDays != null && listItem.waitingDays >= 1 ? `已等待约 ${listItem.waitingDays} 天` : '你已回复，对方尚未回信'}</small>
                </div>
              </div>
            )}

            {aiEnabled && (
              <div className="ai-bar">
                <button className="ai-btn" onClick={runSummary} disabled={summaryLoading || !msg}>
                  {summaryLoading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                  {summary ? '重新分析' : items.length > 1 ? 'AI 总结会话' : 'AI 摘要'}
                </button>
                <button className="ai-btn ghost" onClick={() => runTranslate()} disabled={translating || !msg} title="智能翻译（保留原文）">
                  {translating ? <Loader2 size={14} className="spin" /> : showTranslated ? <Eye size={14} /> : <Languages size={14} />}
                  {translateButtonLabel()}
                </button>
                {translated && lastTranslateTarget && (
                  <button
                    className="ai-btn ghost"
                    onClick={() => runTranslate(lastTranslateTarget === 'English' ? '简体中文' : 'English')}
                    disabled={translating || !msg}
                    title="换目标语言重新翻译"
                  >
                    <Languages size={14} />
                    {lastTranslateTarget === 'English' ? '改译中文' : '改译英文'}
                  </button>
                )}
                <button className="ai-btn ghost" onClick={() => openSmartReply()} disabled={!msg}>
                  <Reply size={14} /> AI 智能回复
                </button>
              </div>
            )}

            {!summary && noteSource?.note && (
              <div className="ai-note-banner">
                <Sparkles size={14} />
                <span className="ai-note-banner-text">{noteSource.note}</span>
                <button className="ai-btn ghost sm" onClick={() => openSmartReply(noteSource.note)} disabled={!msg}>
                  <Reply size={13} /> 据此回复
                </button>
                {aiEnabled && (
                  <button className="ai-btn ghost sm" onClick={runSummary} disabled={summaryLoading || !msg}>
                    {summaryLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} 完整摘要
                  </button>
                )}
              </div>
            )}

            {summary && (
              <div className={'ai-card' + (isPinned ? ' pinned' : '')}>
                <div className="ai-card-head">
                  <Sparkles size={15} /> AI 摘要
                  {summary.fromCache && <span className="pill soft">已缓存</span>}
                  {isPinned && <span className="pill soft"><Pin size={10} /> 已钉选</span>}
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
                <div className="ai-card-actions">
                  <button className="ai-btn" onClick={() => openSmartReply()} disabled={!msg}>
                    <Reply size={14} /> 生成回复
                  </button>
                  {isPinned ? (
                    <button className="ai-btn ghost" onClick={unpinSummary} disabled={pinning}>
                      {pinning ? <Loader2 size={14} className="spin" /> : <Pin size={14} />} 取消钉选
                    </button>
                  ) : (
                    <button className="ai-btn ghost" onClick={pinSummary} disabled={pinning || !summary.summary}>
                      {pinning ? <Loader2 size={14} className="spin" /> : <Pin size={14} />} 钉选到待办
                    </button>
                  )}
                </div>
                {summary.quickReplies?.length > 0 && (
                  <div className="quick-replies">
                    <div className="ai-sub">一键回复</div>
                    <div className="qr-list">
                      {summary.quickReplies.map((r, i) => (
                        <button key={i} onClick={() => openSmartReply(r)}>{r}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {showTranslated && translated && (
              <div className="translated-body">
                <div className="translated-tag">
                  <Languages size={13} /> AI 翻译
                  {translated.fromCache && <span className="pill soft">已缓存</span>}
                  {translated.sourceLang && <span className="translated-meta">原文 · {translated.sourceLang}</span>}
                  {translated.subject && translated.subject !== base.subject && (
                    <span className="translated-meta">主题：{translated.subject}</span>
                  )}
                </div>
                <MailFrame text={translated.body} dark={dark} />
              </div>
            )}

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
                    slaHours={listItem?.priority?.slaHours}
                  />
                </div>
              ))}
            </div>

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
