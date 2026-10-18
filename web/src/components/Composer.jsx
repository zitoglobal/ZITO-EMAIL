import React, { useEffect, useRef, useState } from 'react';
import {
  X, Minus, Maximize2, Minimize2, Send, Paperclip, Bold, Italic, Underline, List, ListOrdered, Link2, Eraser, Sparkles, Loader2,
  Wand2, Scissors, Languages, Save, ChevronDown, Strikethrough, FileStack, Quote, Trash2, Clock, Image,
} from 'lucide-react';
import { api } from '../api.js';
import {
  fileToInlineDataUrl, formatSize, htmlToText, insertHtmlAtCursor, relativeTime, sanitizeHtml, schedulePresets, textToHtml,
} from '../utils.js';
import { signatureHtml, signaturePlain, toPayload } from '../compose.js';
import { ICON_MD, Icon } from '../uiIcons.jsx';
import TimeMenu from './TimeMenu.jsx';

const STAGE_LABEL = {
  inquiry: '询盘', quote: '报价中', sample: '样品', bulk: '大货', payment: '付款', won: '成交', lost: '丢单',
};

const TONES = [
  ['professional', '专业'],
  ['friendly', '友好'],
  ['formal', '正式'],
  ['concise', '简洁'],
  ['persuasive', '销售'],
];
const LANGS = [
  ['', '自动'],
  ['English', '英文'],
  ['简体中文', '中文'],
  ['Español', '西班牙语'],
  ['Français', '法语'],
  ['Deutsch', '德语'],
  ['日本語', '日语'],
  ['Русский', '俄语'],
  ['العربية', '阿拉伯语'],
];
const REWRITES = [
  ['polish', '润色', Wand2],
  ['shorten', '精简', Scissors],
  ['expand', '扩写', Sparkles],
  ['formal', '更正式', Wand2],
  ['friendly', '更友好', Wand2],
  ['en', '译成英文', Languages],
  ['zh', '译成中文', Languages],
];
const MAX_TOTAL = 25 * 1024 * 1024;
const AUTOSAVE_MS = 20_000;

function RecipientInput({ label, value, onChange, autoFocus, right }) {
  const [sugs, setSugs] = useState([]);
  const [active, setActive] = useState(0);
  const last = value.split(/[,;，；]/).pop().trim();

  useEffect(() => {
    if (!last) return setSugs([]);
    let alive = true;
    const t = setTimeout(() => {
      api('/contacts?q=' + encodeURIComponent(last))
        .then((r) => {
          if (!alive) return;
          const chosen = new Set(value.toLowerCase().split(/[,;，；]/).map((s) => s.trim()));
          setSugs(r.contacts.filter((c) => ![...chosen].some((x) => x.includes(c.address.toLowerCase()) && x !== last.toLowerCase())).slice(0, 8));
          setActive(0);
        })
        .catch(() => {});
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);

  function pick(c) {
    const parts = value.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
    parts.pop();
    parts.push(c.name ? `${c.name} <${c.address}>` : c.address);
    onChange(parts.join(', ') + ', ');
    setSugs([]);
  }

  return (
    <div className="c-row">
      <span className="c-label">{label}</span>
      <div className="c-input-wrap">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (!sugs.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % sugs.length); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + sugs.length) % sugs.length); }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sugs[active]); }
            if (e.key === 'Escape') { e.stopPropagation(); setSugs([]); }
          }}
          onBlur={() => setTimeout(() => setSugs([]), 150)}
        />
        {sugs.length > 0 && (
          <div className="suggest">
            {sugs.map((c, i) => (
              <button key={c.address} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
                <b>{c.name || c.address}</b>
                {c.name && <small>{c.address}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}

export default function Composer({ initial, mailboxes, aiEnabled, aiMeta, onSend, onSaveDraft, onClose, notify, stacked, glossary, onOpenSettings }) {
  const [mailboxId, setMailboxId] = useState(initial.mailboxId || mailboxes[0]?.id);
  const [to, setTo] = useState(initial.to || '');
  const [cc, setCc] = useState(initial.cc || '');
  const [bcc, setBcc] = useState(initial.bcc || '');
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [subject, setSubject] = useState(initial.subject || '');
  const [files, setFiles] = useState(initial.files || []);
  const [fwdAtts, setFwdAtts] = useState(initial.forward?.attachments || []);
  const [draftUid, setDraftUid] = useState(initial.draftUid || null);
  const [savedAt, setSavedAt] = useState(null);
  const [view, setView] = useState('normal');
  const [showQuote, setShowQuote] = useState(false);
  const [aiOpen, setAiOpen] = useState(!!initial.aiInstruction || !!initial.openAi);
  const [aiPrompt, setAiPrompt] = useState(initial.aiInstruction || '');
  const [tone, setTone] = useState('professional');
  const [lang, setLang] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRoute, setAiRoute] = useState(null);
  const [imgBusy, setImgBusy] = useState(false);
  const inlineImgInput = useRef(null);
  const [menu, setMenu] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const editor = useRef();
  const fileInput = useRef();
  const dirty = useRef(false);
  const mailbox = mailboxes.find((m) => m.id === mailboxId) || mailboxes[0];
  const isReply = initial.mode === 'reply' || initial.mode === 'replyAll';

  useEffect(() => {
    editor.current.innerHTML = initial.body ?? `<div><br></div><br>${signatureHtml(mailbox?.signature)}`;
    if (isReply || initial.body) {
      editor.current.focus();
      placeCaretAtStart(editor.current);
    }
    if (initial.aiInstruction && aiEnabled) generate(initial.aiInstruction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动保存草稿
  const latest = useRef();
  latest.current = { saveDraft, hasContent, saving };
  useEffect(() => {
    const t = setInterval(() => {
      const { saveDraft, hasContent, saving } = latest.current;
      if (dirty.current && hasContent() && !saving) saveDraft(true);
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, []);

  function placeCaretAtStart(el) {
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const touch = () => {
    dirty.current = true;
  };

  const exec = (cmd, val) => {
    editor.current.focus();
    document.execCommand(cmd, false, val);
    touch();
  };

  function switchMailbox(id) {
    const next = mailboxes.find((m) => m.id === id);
    setMailboxId(id);
    const sig = editor.current.querySelector('.zm-sig');
    const html = signatureHtml(next?.signature);
    if (sig) {
      if (html) sig.outerHTML = html;
      else sig.remove();
    } else if (html) {
      editor.current.insertAdjacentHTML('beforeend', '<br>' + html);
    }
    touch();
  }

  function state(extra = {}) {
    return {
      ...initial,
      mailboxId,
      to,
      cc,
      bcc,
      subject,
      draftUid,
      body: editor.current?.innerHTML || '',
      forward: initial.forward ? { ...initial.forward, attachments: fwdAtts } : undefined,
      files,
      aiInstruction: '',
      ...extra,
    };
  }

  function collect() {
    const s = state();
    return { payload: toPayload(s, s.body, fwdAtts), files, state: s };
  }

  function bodyTextWithoutSig() {
    const root = editor.current;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.zm-sig').forEach((n) => n.remove());
    return htmlToText(clone.innerHTML).trim();
  }

  function hasContent() {
    return !!(to.trim() || subject.trim() || bodyTextWithoutSig() || files.length);
  }

  async function send(sendAt) {
    if (!to.trim() && !cc.trim() && !bcc.trim()) return notify('请填写收件人', 'error');
    if (!subject.trim() && !window.confirm('邮件没有主题，确定发送吗？')) return;
    const text = htmlToText(editor.current.innerHTML);
    if (/附件|attach(ed|ment)/i.test(text + subject) && !files.length && !fwdAtts.length) {
      if (!window.confirm('正文提到了"附件"，但还没有添加附件。仍然发送吗？')) return;
    }
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL) return notify('附件总大小不能超过 25MB', 'error');
    const { payload, state: s } = collect();
    if (sendAt) payload.sendAt = sendAt;
    onSend(payload, files, s);
  }

  async function saveDraft(silent) {
    setSaving(true);
    try {
      const { payload } = collect();
      const res = await onSaveDraft(payload, files);
      if (res?.uid) setDraftUid(res.uid);
      dirty.current = false;
      setSavedAt(Date.now());
      if (!silent) notify('草稿已保存');
    } catch (e) {
      if (!silent) notify(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  function close() {
    onClose(dirty.current && hasContent() ? collect() : null);
  }

  function discard() {
    if (!window.confirm('确定舍弃这封邮件吗？')) return;
    onClose(null, { discard: true, draftUid, mailboxId });
  }

  async function generate(instruction = aiPrompt) {
    if (!instruction.trim() && !initial.sourceId) return notify('请描述你想写的邮件内容', 'error');
    setAiBusy(true);
    try {
      const sig = signaturePlain(mailbox?.signature || '');
      const full = initial.aiContext && instruction === (initial.aiInstruction || aiPrompt)
        ? initial.aiContext
        : (initial.aiContext ? `${initial.aiContext}\n回复意图：${instruction}` : instruction);
      const withSig = (bodyHtml) => {
        const sigBlock = signatureHtml(mailbox?.signature);
        // AI 正文用纯文本渲染；签名单独附加，避免盖掉 Logo
        return `<div>${bodyHtml}</div>${sigBlock ? `<br>${sigBlock}` : ''}`;
      };
      if (initial.sourceId && initial.mode !== 'forward') {
        const r = await api('/ai/reply', { method: 'POST', body: { id: initial.sourceId, instruction: full, tone, language: lang, signature: sig } });
        editor.current.innerHTML = withSig(textToHtml(r.body));
        setAiRoute(r.aiRoute || null);
      } else {
        const r = await api('/ai/compose', { method: 'POST', body: { prompt: full, tone, language: lang, to, signature: sig } });
        if (r.subject && !subject.trim()) setSubject(r.subject);
        editor.current.innerHTML = withSig(textToHtml(r.body || ''));
        setAiRoute(r.aiRoute || null);
      }
      touch();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function rewrite(mode) {
    setMenu(null);
    const sel = window.getSelection();
    const inEditor = sel.rangeCount && editor.current.contains(sel.anchorNode) && !sel.isCollapsed;
    const range = inEditor ? sel.getRangeAt(0).cloneRange() : null;
    const source = inEditor ? sel.toString() : htmlToText(editor.current.innerHTML);
    if (!source.trim()) return notify('请先输入或选中需要处理的内容', 'error');
    setAiBusy(true);
    try {
      const r = await api('/ai/rewrite', { method: 'POST', body: { text: source, mode } });
      if (range) {
        range.deleteContents();
        range.insertNode(range.createContextualFragment(textToHtml(r.text)));
      } else {
        editor.current.innerHTML = textToHtml(r.text);
      }
      touch();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function openTemplates() {
    setMenu(menu === 'tpl' ? null : 'tpl');
    if (!templates) {
      try {
        setTemplates((await api('/templates')).templates);
      } catch (e) {
        notify(e.message, 'error');
      }
    }
  }

  function applyTemplate(t) {
    setMenu(null);
    const first = to.split(/[,;，；]/)[0]?.trim() || '';
    const m = first.match(/^(.*)<(.+)>$/);
    const name = (m ? m[1].trim().replace(/^"|"$/g, '') : '') || (m ? m[2] : first).split('@')[0] || '';
    const fill = (s) => String(s || '').replace(/\{\{\s*(name|姓名)\s*\}\}/g, name).replace(/\{\{\s*(sender|我)\s*\}\}/g, mailbox?.name || '');
    if (t.subject && !subject.trim()) setSubject(fill(t.subject));
    const sig = editor.current.querySelector('.zm-sig')?.outerHTML || '';
    editor.current.innerHTML = `<div>${textToHtml(fill(t.body))}</div><br>${sig}`;
    touch();
  }

  function insertQuoteSnippet() {
    const snip = initial.quoteSnippet || '';
    if (!snip) return notify('当前客户暂无报价要点，请先在成交条填写', 'error');
    editor.current.focus();
    insertHtmlAtCursor(`<pre class="zm-quote-snip">${snip.replace(/</g, '&lt;')}</pre><br>`, editor.current);
    touch();
  }

  function groupedTemplates(list) {
    if (!list?.length) return [];
    const brandId = mailbox?.brandId || null;
    const sorted = [...list].sort((a, b) => {
      const aBrand = brandId && a.brandId === brandId ? 0 : a.brandId ? 1 : 2;
      const bBrand = brandId && b.brandId === brandId ? 0 : b.brandId ? 1 : 2;
      if (aBrand !== bBrand) return aBrand - bBrand;
      const aStage = a.stage || '';
      const bStage = b.stage || '';
      if (aStage !== bStage) return aStage.localeCompare(bStage);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    const groups = [];
    let cur = null;
    for (const t of sorted) {
      const key = `${t.brandId || 'any'}:${t.stage || 'any'}`;
      if (!cur || cur.key !== key) {
        const bits = [];
        if (t.brandId && brandId && t.brandId === brandId) bits.push('当前品牌');
        else if (t.brandId) bits.push('其它品牌');
        if (t.stage) bits.push(STAGE_LABEL[t.stage] || t.stage);
        cur = { key, label: bits.join(' · ') || '通用', items: [] };
        groups.push(cur);
      }
      cur.items.push(t);
    }
    return groups;
  }

  async function saveAsTemplate() {
    setMenu(null);
    const name = window.prompt('模板名称', subject || '新模板');
    if (!name) return;
    const body = bodyTextWithoutSig();
    try {
      await api('/templates', { method: 'POST', body: { name, subject, body } });
      setTemplates(null);
      notify('已保存为模板，可在正文中使用 {{name}} 代表收件人称呼');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  function addFiles(list) {
    const arr = [...list];
    const total = [...files, ...arr].reduce((s, f) => s + f.size, 0);
    if (total > MAX_TOTAL) return notify('附件总大小不能超过 25MB', 'error');
    setFiles((f) => [...f, ...arr]);
    touch();
  }

  async function insertInlineImage(file) {
    if (!file || !editor.current) return;
    setImgBusy(true);
    try {
      const dataUrl = await fileToInlineDataUrl(file, { maxW: 720, maxH: 720, maxBytes: 220_000 });
      const html = `<img src="${dataUrl}" alt="" style="max-width:100%;height:auto" />`;
      editor.current.focus();
      insertHtmlAtCursor(html, editor.current);
      touch();
    } catch (e) {
      notify(e.message || '插入图片失败', 'error');
    } finally {
      setImgBusy(false);
    }
  }

  async function handleEditorPaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const imageItems = items.filter((i) => i.type.startsWith('image/'));
    if (imageItems.length) {
      e.preventDefault();
      for (const item of imageItems) {
        const f = item.getAsFile();
        if (f) await insertInlineImage(f);
      }
      return;
    }
    const html = e.clipboardData?.getData('text/html');
    if (html && /<img\b/i.test(html)) {
      e.preventDefault();
      insertHtmlAtCursor(sanitizeHtml(html), editor.current);
      touch();
      return;
    }
    const clipFiles = [...(e.clipboardData?.files || [])].filter((f) => !String(f.type || '').startsWith('image/'));
    if (clipFiles.length) {
      e.preventDefault();
      addFiles(clipFiles);
    }
  }

  const title = { new: '新邮件', reply: '回复', replyAll: '全部回复', forward: '转发', draft: '编辑草稿' }[initial.mode] || '新邮件';
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  if (view === 'min') {
    return (
      <div className={'composer minimized' + (stacked ? ' stacked' : '')} onClick={() => setView('normal')}>
        <span>{subject || title}</span>
        <div className="c-head-actions">
          <button onClick={(e) => { e.stopPropagation(); setView('normal'); }}><Maximize2 size={14} /></button>
          <button onClick={(e) => { e.stopPropagation(); close(); }}><X size={15} /></button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={'composer' + (view === 'max' ? ' maximized' : '') + (dragging ? ' dragging' : '') + (stacked ? ' stacked' : '')}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft(false); }
        if (e.key === 'Escape') { e.stopPropagation(); setView('min'); }
        e.stopPropagation();
      }}
    >
      <div className="c-head" onDoubleClick={() => setView(view === 'max' ? 'normal' : 'max')}>
        <span>{title}</span>
        {savedAt && <small className="c-saved">{saving ? '保存中…' : `草稿已保存 ${relativeTime(savedAt)}`}</small>}
        <div className="c-head-actions">
          <button onClick={() => setView('min')} title="最小化"><Minus size={15} /></button>
          <button onClick={() => setView(view === 'max' ? 'normal' : 'max')} title="全屏">
            {view === 'max' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button onClick={close} title="关闭（自动存草稿）"><X size={15} /></button>
        </div>
      </div>

      {mailboxes.length > 1 && (
        <div className="c-row">
          <span className="c-label">发件人</span>
          <div className="c-from">
            <span className="mb-dot" style={{ background: mailbox?.color }} />
            <select value={mailboxId} onChange={(e) => switchMailbox(e.target.value)}>
              {mailboxes.map((m) => (
                <option key={m.id} value={m.id}>{m.name ? `${m.name} <${m.email}>` : m.email}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <RecipientInput
        label="收件人"
        value={to}
        onChange={(v) => { setTo(v); touch(); }}
        autoFocus={!isReply && !initial.to}
        right={!showCc && <button className="c-link" onClick={() => setShowCc(true)}>抄送/密送</button>}
      />
      {showCc && (
        <>
          <RecipientInput label="抄送" value={cc} onChange={(v) => { setCc(v); touch(); }} />
          <RecipientInput label="密送" value={bcc} onChange={(v) => { setBcc(v); touch(); }} />
        </>
      )}
      <div className="c-row">
        <span className="c-label">主题</span>
        <input className="c-subject" value={subject} onChange={(e) => { setSubject(e.target.value); touch(); }} />
      </div>

      {aiEnabled && aiOpen && (
        <div className="ai-compose">
          <div className="ai-compose-head">
            <Sparkles size={14} /> {initial.sourceId && initial.mode !== 'forward' ? 'AI 回复助手（已结合整个会话上下文）' : 'AI 写信助手'}
            {initial.aiContext && <span className="ai-context-tag">已带入摘要</span>}
            <button className="c-link" onClick={() => setAiOpen(false)}>收起</button>
          </div>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder={initial.sourceId ? '想怎么回复？例如：感谢询价，告知报价将在 2 个工作日内发出，并询问目标数量' : '想写什么？例如：给美国客户写一封开发信，介绍我们的瑜伽服 OEM 能力，MOQ 300 件'}
            rows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          />
          <div className="ai-compose-opts">
            <select value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map(([k, l]) => <option key={k} value={k}>语气：{l}</option>)}
            </select>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map(([k, l]) => <option key={k} value={k}>语言：{l}</option>)}
            </select>
            <button className="btn-primary sm" onClick={() => generate()} disabled={aiBusy}>
              {aiBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 生成
            </button>
          </div>
          {aiRoute && (
            <div className="ai-route-chip" title={aiRoute.reason || ''}>
              路由 · {aiRoute.tier === 'fast' ? '快' : aiRoute.tier === 'mid' ? '中' : '强'}
              {aiRoute.thinking ? ' · 思考' : ''}
              {aiRoute.reason ? ` · ${aiRoute.reason}` : ''}
            </div>
          )}
        </div>
      )}

      <div className="c-body">
        {aiBusy && <div className="c-busy"><Loader2 size={18} className="spin" /> AI 正在撰写…</div>}
        <div
          ref={editor}
          className="c-editor"
          contentEditable
          suppressContentEditableWarning
          onInput={touch}
          onPaste={handleEditorPaste}
        />
        {initial.quoteHtml && (
          <div className="c-quote">
            <button className="c-link" onClick={() => setShowQuote((v) => !v)}>
              <Quote size={12} /> {showQuote ? '隐藏引用内容' : initial.mode === 'forward' ? '查看转发的原邮件' : '··· 显示引用内容'}
            </button>
            {showQuote && <div className="c-quote-body">{initial.quoteText || ''}</div>}
          </div>
        )}
      </div>

      {(files.length > 0 || fwdAtts.length > 0) && (
        <div className="c-files">
          {fwdAtts.map((a) => (
            <span key={'f' + a.index} className="file-chip">
              <Paperclip size={12} /> {a.filename} <small>{formatSize(a.size)}</small>
              <button onClick={() => { setFwdAtts((l) => l.filter((x) => x.index !== a.index)); touch(); }}><X size={12} /></button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={i} className="file-chip">
              <Paperclip size={12} /> {f.name} <small>{formatSize(f.size)}</small>
              <button onClick={() => { setFiles((l) => l.filter((_, j) => j !== i)); touch(); }}><X size={12} /></button>
            </span>
          ))}
          {totalSize > 0 && <small className="c-total">共 {formatSize(totalSize)} / 25MB</small>}
        </div>
      )}

      <div className="c-toolbar">
        <div className="send-group">
          <button className="btn-primary send" onClick={() => send()} title="发送 (Ctrl+Enter)">
            <Icon as={Send} {...ICON_MD} /> 发送
          </button>
          <div className="move-wrap">
            <button className="btn-primary send-more" onClick={() => setMenu(menu === 'schedule' ? null : 'schedule')} title="定时发送">
              <ChevronDown size={14} />
            </button>
            {menu === 'schedule' && (
              <TimeMenu
                title="定时发送"
                presets={schedulePresets()}
                className="up"
                onClose={() => setMenu(null)}
                onPick={(t) => { setMenu(null); send(t); }}
              />
            )}
          </div>
        </div>
        <div className="fmt" role="toolbar" aria-label="正文格式">
          <button type="button" onClick={() => exec('bold')} title="加粗"><Icon as={Bold} {...ICON_MD} /></button>
          <button type="button" onClick={() => exec('italic')} title="斜体"><Icon as={Italic} {...ICON_MD} /></button>
          <button type="button" onClick={() => exec('underline')} title="下划线"><Icon as={Underline} {...ICON_MD} /></button>
          <button type="button" onClick={() => exec('strikeThrough')} title="删除线"><Icon as={Strikethrough} {...ICON_MD} /></button>
          <span className="fmt-sep" aria-hidden />
          <button type="button" onClick={() => exec('insertUnorderedList')} title="项目符号"><Icon as={List} {...ICON_MD} /></button>
          <button type="button" onClick={() => exec('insertOrderedList')} title="编号"><Icon as={ListOrdered} {...ICON_MD} /></button>
          <button
            type="button"
            onClick={() => {
              const url = window.prompt('链接地址', 'https://');
              if (url && /^(https?:\/\/|mailto:)/i.test(url)) exec('createLink', url);
            }}
            title="插入链接"
          >
            <Icon as={Link2} {...ICON_MD} />
          </button>
          <button type="button" onClick={() => exec('removeFormat')} title="清除格式"><Icon as={Eraser} {...ICON_MD} /></button>
          <span className="fmt-sep" aria-hidden />
          <button
            type="button"
            onClick={() => inlineImgInput.current?.click()}
            title="插入正文图片（非附件）"
            disabled={imgBusy}
          >
            {imgBusy ? <Icon as={Loader2} {...ICON_MD} className="spin" /> : <Icon as={Image} {...ICON_MD} />}
          </button>
          <button type="button" onClick={() => fileInput.current.click()} title="添加附件"><Icon as={Paperclip} {...ICON_MD} /></button>
          <input
            ref={inlineImgInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) insertInlineImage(f);
            }}
          />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <div className="move-wrap">
            <button onClick={openTemplates} title="邮件模板"><FileStack size={15} /></button>
            {menu === 'tpl' && (
              <div className="dropdown up scroll" onMouseLeave={() => setMenu(null)}>
                <div className="dropdown-title">插入模板</div>
                {!templates && <div className="dropdown-tip"><Loader2 size={12} className="spin" /> 加载中…</div>}
                {templates?.length === 0 && <div className="dropdown-tip">还没有模板</div>}
                {groupedTemplates(templates).map((g) => (
                  <React.Fragment key={g.key}>
                    {g.label && <div className="dropdown-tip">{g.label}</div>}
                    {g.items.map((t) => (
                      <button key={t.id} onClick={() => applyTemplate(t)}>
                        <span>
                          {t.name}
                          {t.shared ? <em className="tpl-team">团队</em> : null}
                        </span>
                        {t.subject && <small>{t.subject}</small>}
                      </button>
                    ))}
                  </React.Fragment>
                ))}
                <div className="menu-sep" />
                <button onClick={saveAsTemplate}><Save size={13} /> 把当前内容存为模板</button>
              </div>
            )}
          </div>
          {initial.quoteSnippet && (
            <button type="button" onClick={insertQuoteSnippet} title="插入当前报价要点">
              <Quote size={15} />
            </button>
          )}
        </div>
        {aiEnabled ? (
          <div className="ai-tools">
            <button type="button" className={'ai-chip' + (aiOpen ? ' on' : '')} onClick={() => setAiOpen((v) => !v)}>
              <Sparkles size={14} /> AI 写作
            </button>
            <div className="move-wrap">
              <button type="button" className="ai-chip" onClick={() => setMenu(menu === 'rewrite' ? null : 'rewrite')} disabled={aiBusy}>
                <Wand2 size={14} /> 改写 <ChevronDown size={12} />
              </button>
              {menu === 'rewrite' && (
                <div className="dropdown up" onMouseLeave={() => setMenu(null)}>
                  {REWRITES.map(([k, l, Icon]) => (
                    <button key={k} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => rewrite(k)}>
                      <Icon size={13} /> {l}
                    </button>
                  ))}
                  <div className="dropdown-tip">可先选中部分文字，仅改写选中内容</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <span className="ai-off-inline">
            {aiMeta?.cloudOk === false
              ? '已关闭云端 AI · '
              : aiMeta?.configured === false
                ? 'AI 未配置 · '
                : '智能润色暂不可用 · '}
            <button type="button" onClick={() => onOpenSettings?.('preferences')}>去设置</button>
          </span>
        )}
        <div className="c-tail">
          <button className="icon-btn" onClick={() => saveDraft(false)} title="保存草稿 (Ctrl+S)" disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
          </button>
          <button className="icon-btn" onClick={discard} title="舍弃"><Trash2 size={15} /></button>
        </div>
      </div>

      {Array.isArray(glossary) && glossary.length > 0 && (
        <div className="composer-glossary" aria-label="术语表">
          {glossary.slice(0, 12).map((g) => (
            <button
              key={g.src}
              type="button"
              title={`插入 ${g.src} → ${g.dst}`}
              onClick={() => {
                const el = editor.current;
                if (!el) return;
                el.focus();
                document.execCommand('insertText', false, g.src);
                touch();
              }}
            >
              {g.src}
            </button>
          ))}
        </div>
      )}
      {initial.scheduledFor && (
        <div className="c-note"><Clock size={12} /> 原定于 {new Date(initial.scheduledFor).toLocaleString('zh-CN')} 发送，修改后请重新发送或定时</div>
      )}
    </div>
  );
}
