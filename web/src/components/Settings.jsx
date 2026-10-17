import React, { useEffect, useState } from 'react';
import {
  X, Trash2, Plus, Moon, Sun, Bell, Sparkles, RefreshCw, ArrowUp, ArrowDown, Server, Loader2, AlertCircle, CheckCircle2, Mail,
  SlidersHorizontal, FileStack, User, Users, Pencil, LogOut, Image, Undo2, MessagesSquare, Rows3, KeyRound, ListTodo, Hourglass, Send,
  BellRing, Crown, BellOff, Languages, BookMarked, LayoutPanelLeft, Tag, ShieldCheck, Hand, Smartphone,
} from 'lucide-react';
import { LAYOUT_MODES } from '../layout.js';
import { api } from '../api.js';
import { MAILBOX_COLORS, relativeTime } from '../utils.js';
import MailboxForm from './MailboxForm.jsx';
import MailRulesPanel from './MailRulesPanel.jsx';
import ContactsPanel from './ContactsPanel.jsx';
import { disableWebPush, enableWebPush, pushStatus } from '../pushClient.js';

const TRADE_GLOSSARY_PRESET = [
  { src: 'MOQ', dst: '最小起订量' },
  { src: 'FOB', dst: '离岸价（船上交货）' },
  { src: 'CIF', dst: '到岸价（成本+保险+运费）' },
  { src: 'EXW', dst: '工厂交货价' },
  { src: 'CFR', dst: '成本加运费' },
  { src: 'Lab Dip', dst: '色样 / 确认色' },
  { src: 'PP sample', dst: '产前样' },
  { src: 'SMS', dst: '推销样' },
  { src: 'Bulk', dst: '大货' },
  { src: 'Lead time', dst: '交货周期' },
  { src: 'PO', dst: '采购订单' },
  { src: 'PI', dst: '形式发票' },
  { src: 'SKU', dst: '货号 / 库存单位' },
  { src: 'OEM', dst: '贴牌生产' },
  { src: 'ODM', dst: '设计代工' },
  { src: 'QC', dst: '质检' },
  { src: 'T/T', dst: '电汇' },
  { src: 'L/C', dst: '信用证' },
];

const TABS = [
  ['mailboxes', '邮箱账号', Mail],
  ['triage', '智能分拣', ListTodo],
  ['labels', '标签', Tag],
  ['preferences', '偏好设置', SlidersHorizontal],
  ['templates', '邮件模板', FileStack],
  ['account', '账户与安全', User],
  ['team', '团队成员', Users],
];

const DEFAULT_LABEL_COLORS = ['#0a66ff', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#475569', '#0891b2'];


function MailboxCard({ mb, index, total, onMove, onChanged, notify, focus }) {
  const [name, setName] = useState(mb.name || '');
  const [color, setColor] = useState(mb.color);
  const [signature, setSignature] = useState(mb.signature || '');
  const [editConn, setEditConn] = useState(focus && mb.status === 'error');
  const [busy, setBusy] = useState('');
  const dirty = name !== (mb.name || '') || color !== mb.color || signature !== (mb.signature || '');

  async function save() {
    setBusy('save');
    try {
      await api(`/mailboxes/${mb.id}`, { method: 'PATCH', body: { name, color, signature } });
      notify('已保存');
      onChanged();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      await api(`/mailboxes/${mb.id}/sync`, { method: 'POST', body: {} });
      notify('已开始同步');
      setTimeout(onChanged, 1500);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (!window.confirm(`确定解绑 ${mb.email} 吗？\n本地缓存会被清除，服务器上的邮件不受影响。`)) return;
    try {
      await api(`/mailboxes/${mb.id}`, { method: 'DELETE' });
      notify('邮箱已解绑');
      onChanged();
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  return (
    <div className={'set-account' + (focus ? ' focus' : '')}>
      <div className="set-account-head">
        <span className="mb-dot lg" style={{ background: color }} />
        <div className="account-text">
          <b>{mb.email}</b>
          <small>
            {mb.providerName} · {mb.imap.host}
            {mb.status === 'ok' && mb.lastSync && <> · 同步于 {relativeTime(mb.lastSync)}</>}
          </small>
        </div>
        <span className={'status-pill ' + mb.status}>
          {mb.status === 'error' ? <><AlertCircle size={12} /> 连接异常</> : mb.status === 'ok' ? <><CheckCircle2 size={12} /> 正常</> : <><Loader2 size={12} className="spin" /> 同步中</>}
        </span>
        <div className="order-btns">
          <button className="icon-btn" disabled={index === 0} onClick={() => onMove(index, -1)} title="上移"><ArrowUp size={14} /></button>
          <button className="icon-btn" disabled={index === total - 1} onClick={() => onMove(index, 1)} title="下移"><ArrowDown size={14} /></button>
        </div>
      </div>
      {mb.status === 'error' && mb.lastError && <div className="form-error">{mb.lastError}</div>}

      <div className="row-2">
        <label className="field">
          <span>发件人显示名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>标识颜色</span>
          <div className="color-row">
            {MAILBOX_COLORS.map((c) => (
              <button type="button" key={c} className={'color-dot' + (color === c ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      </div>
      <label className="field">
        <span>签名（写信时自动附加，切换发件邮箱时自动替换）</span>
        <textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={'例如：\nAlice Chen | Sales Manager\nGuangzhou Elevia Apparel Technology Co., Ltd.'} />
      </label>
      <div className="set-actions">
        <button className="btn-primary sm" disabled={!dirty || busy === 'save'} onClick={save}>
          {busy === 'save' && <Loader2 size={13} className="spin" />} 保存
        </button>
        <button className="btn-ghost sm" onClick={syncNow} disabled={busy === 'sync'}>
          <RefreshCw size={13} className={busy === 'sync' ? 'spin' : ''} /> 立即同步
        </button>
        <button className="btn-ghost sm" onClick={() => setEditConn((v) => !v)}>
          <Server size={13} /> {mb.authType === 'oauth' ? '重新授权 / 服务器' : '密码与服务器'}
        </button>
        <span className="spacer" />
        <button className="btn-ghost sm danger" onClick={remove}><Trash2 size={13} /> 解绑</button>
      </div>
      {mb.authType === 'oauth' && (
        <small className="muted oauth-hint">OAuth 连接 · {mb.oauthProvider === 'microsoft' ? 'Microsoft 365' : 'Google'}{mb.status === 'error' ? ' · 若报授权失效请点上方重新授权' : ''}</small>
      )}
      {editConn && (
        <div className="conn-edit">
          <MailboxForm
            mailbox={mb}
            compact
            onDone={() => {
              notify('连接已更新，正在重新同步');
              setEditConn(false);
              onChanged();
            }}
            onCancel={() => setEditConn(false)}
          />
        </div>
      )}
    </div>
  );
}

function Mailboxes({ mailboxes, onChanged, onAdd, notify, focusId }) {
  async function move(i, d) {
    const ids = mailboxes.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await api('/mailboxes/order', { method: 'POST', body: { ids } }).catch((e) => notify(e.message, 'error'));
    onChanged();
  }
  return (
    <>
      <p className="set-desc">一个平台账号可以同时绑定多个邮箱，在「所有收件箱」中统一收取，写信时自由切换发件人。</p>
      {mailboxes.map((mb, i) => (
        <MailboxCard key={mb.id + mb.status + (mb.lastError || '')} mb={mb} index={i} total={mailboxes.length} onMove={move} onChanged={onChanged} notify={notify} focus={focusId === mb.id} />
      ))}
      <button className="btn-ghost" onClick={onAdd}><Plus size={15} /> 绑定新邮箱</button>
    </>
  );
}

function Toggle({ icon: Icon, label, desc, checked, onChange }) {
  return (
    <label className="set-row">
      <span className="set-label"><Icon size={15} /> <span>{label}{desc && <small>{desc}</small>}</span></span>
      <input type="checkbox" className="switch" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Choice({ icon: Icon, label, value, options, onChange }) {
  return (
    <div className="set-row">
      <span className="set-label"><Icon size={15} /> <span>{label}</span></span>
      <div className="segmented">
        {options.map(([v, l]) => (
          <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function GlossaryEditor({ glossary, onSave }) {
  const rows = Array.isArray(glossary) ? glossary : [];
  const [draft, setDraft] = useState({ src: '', dst: '' });

  function mergeEntries(extra) {
    const map = new Map(rows.map((r) => [r.src.toLowerCase(), r]));
    for (const e of extra) {
      if (!e?.src || !e?.dst) continue;
      map.set(String(e.src).toLowerCase(), { src: String(e.src).slice(0, 80), dst: String(e.dst).slice(0, 80) });
    }
    return [...map.values()].slice(0, 50);
  }

  function add(e) {
    e.preventDefault();
    const src = draft.src.trim();
    const dst = draft.dst.trim();
    if (!src || !dst) return;
    if (rows.length >= 50) return;
    onSave({ glossary: mergeEntries([{ src, dst }]) });
    setDraft({ src: '', dst: '' });
  }

  function remove(src) {
    onSave({ glossary: rows.filter((r) => r.src !== src) });
  }

  function applyPreset() {
    onSave({ glossary: mergeEntries(TRADE_GLOSSARY_PRESET) });
  }

  return (
    <div className="glossary-block">
      <div className="set-row glossary-head">
        <span className="set-label"><BookMarked size={15} /> <span>翻译术语表<small>外贸专用词（MOQ、面料名、SKU 等），翻译 / 润色 / 写信时优先套用，最多 50 条</small></span></span>
        <button type="button" className="btn-ghost sm" onClick={applyPreset} title="合并写入常用外贸术语；同名条目保留你已有的译文">
          <Sparkles size={13} /> 一键外贸预设
        </button>
      </div>
      {rows.length > 0 && (
        <div className="glossary-list">
          {rows.map((r) => (
            <div key={r.src} className="glossary-row">
              <span className="glossary-src">{r.src}</span>
              <span className="glossary-arrow">→</span>
              <span className="glossary-dst">{r.dst}</span>
              <button type="button" className="icon-btn danger" onClick={() => remove(r.src)} title="删除"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <form className="glossary-add" onSubmit={add}>
        <input value={draft.src} onChange={(e) => setDraft({ ...draft, src: e.target.value })} placeholder="原文术语，如 MOQ" maxLength={80} />
        <span className="glossary-arrow">→</span>
        <input value={draft.dst} onChange={(e) => setDraft({ ...draft, dst: e.target.value })} placeholder="译文，如 最小起订量" maxLength={80} />
        <button type="submit" className="btn-ghost sm" disabled={!draft.src.trim() || !draft.dst.trim() || rows.length >= 50}>
          <Plus size={13} /> 添加
        </button>
      </form>
    </div>
  );
}

function PushRow({ notify }) {
  const [n, setN] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushStatus().then((d) => setN((d.subscriptions || []).length)).catch(() => {});
  }, []);
  return (
    <div className="set-row">
      <div className="set-row-label">
        <Smartphone size={16} />
        <div>
          <b>关闭网页后的推送</b>
          <small>安装为 PWA / 允许推送后，新邮件与超时提醒可在浏览器关闭时送达（需 HTTPS）</small>
        </div>
      </div>
      <div className="set-actions">
        {n > 0 && <span className="set-hint">已订阅 {n} 台</span>}
        <button
          type="button"
          className="btn-primary sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await enableWebPush();
              const d = await pushStatus();
              setN((d.subscriptions || []).length);
              notify('推送已开启', 'success');
            } catch (e) {
              notify(e.message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={13} className="spin" /> : null}
          {n ? '重新订阅' : '开启推送'}
        </button>
        {n > 0 && (
          <button
            type="button"
            className="btn-ghost sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await disableWebPush();
                setN(0);
                notify('已关闭推送');
              } catch (e) {
                notify(e.message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            关闭
          </button>
        )}
      </div>
    </div>
  );
}

function Preferences({ settings, onSave, aiEnabled, aiMeta, notify, onAiCloudChange }) {
  const set = (k) => (v) => {
    onSave({ [k]: v });
    if (k === 'notify' && v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    if (k === 'aiCloudOk') onAiCloudChange?.(!!v);
  };
  const translateTarget = settings.translateTarget === 'English' || settings.translateTarget === '英文' ? 'English' : '简体中文';
  const cloudOk = settings.aiCloudOk !== false;
  const vendor = aiMeta?.vendorHost || '';
  const configured = aiMeta?.configured ?? aiEnabled;
  return (
    <>
      <div className={'ai-status-card ' + (aiEnabled ? 'on' : 'off')} id="ai-status">
        <b>
          {aiEnabled
            ? '智能功能已开启 · 邮件会发往云端模型'
            : configured && !cloudOk
              ? '云端 AI 已按你的选择关闭'
              : '智能功能未开通 · 请联系管理员配置服务器 AI 密钥'}
        </b>
        <small>
          {aiEnabled
            ? `摘要、翻译、润色、分诊等会把主题与正文发送至 ${vendor || '已配置的 AI 服务'}，请勿对极度敏感邮件使用。`
            : configured && !cloudOk
              ? '关闭后摘要/翻译/分诊不可用，邮件不会外发。需要时再打开下方开关。'
              : '密钥在服务端 .env，此处只读。'}
        </small>
      </div>
      {configured && (
        <Toggle
          icon={Sparkles}
          label="允许云端 AI（邮件出域）"
          desc={vendor ? `开启后内容发往 ${vendor}` : '开启后邮件内容会发送到服务器配置的 AI 接口'}
          checked={cloudOk}
          onChange={set('aiCloudOk')}
        />
      )}
      <Choice icon={settings.theme === 'dark' ? Moon : Sun} label="外观" value={settings.theme} onChange={set('theme')} options={[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]} />
      <Choice icon={Rows3} label="列表密度" value={settings.density} onChange={set('density')} options={[['comfortable', '舒适'], ['compact', '紧凑']]} />
      <Choice
        icon={LayoutPanelLeft}
        label="布局模式"
        value={settings.layoutMode || 'standard'}
        onChange={set('layoutMode')}
        options={LAYOUT_MODES.map((m) => [m.id, m.label])}
      />
      <p className="hint-line">标准：经典三栏；销售台：右侧常驻客户栏（窗口≥1180px）；专注读信：侧栏收成图标轨。栏宽可拖拽，双击分隔条恢复默认。</p>
      <Choice icon={Image} label="外部图片" value={settings.remoteImages} onChange={set('remoteImages')} options={[['always', '总是显示'], ['contacts', '仅联系人'], ['never', '询问']]} />
      <Choice icon={Undo2} label="撤销发送时长" value={settings.undoSeconds} onChange={set('undoSeconds')} options={[[0, '关闭'], [5, '5 秒'], [10, '10 秒'], [20, '20 秒'], [30, '30 秒']]} />
      <Toggle icon={MessagesSquare} label="会话视图" desc="把同一主题的往来邮件合并展示" checked={settings.conversationView} onChange={set('conversationView')} />
      <Toggle icon={Sparkles} label="打开邮件时自动生成 AI 摘要" checked={!!settings.autoSummary && cloudOk} onChange={set('autoSummary')} />
      <Choice icon={Languages} label="默认翻译目标" value={translateTarget} onChange={set('translateTarget')} options={[['简体中文', '中文'], ['English', 'English']]} />
      <Toggle icon={Languages} label="打开邮件时自动翻译" desc="外文邮件自动译成默认目标语言（消耗 AI 额度，默认关闭）" checked={!!settings.autoTranslate && cloudOk} onChange={set('autoTranslate')} />
      <Toggle
        icon={ListTodo}
        label="进入今日待办时自动 AI 分诊"
        desc="对尚未分析的待回复邮件自动调用轻量模型（默认关闭，控制额度）"
        checked={!!settings.autoTriageFocus && cloudOk}
        onChange={set('autoTriageFocus')}
      />
      {aiMeta?.models && (
        <p className="set-desc muted-note">
          模型路由：快 {aiMeta.models.fast} · 中 {aiMeta.models.mid} · 强 {aiMeta.models.strong}
          {aiMeta.vendorHost ? ` · ${aiMeta.vendorHost}` : ''}
        </p>
      )}
      <Toggle icon={Bell} label="新邮件桌面通知" desc="浏览器在后台时弹出系统通知" checked={settings.notify} onChange={set('notify')} />
      <PushRow notify={notify || (() => {})} />
      <GlossaryEditor glossary={settings.glossary} onSave={onSave} />
    </>
  );
}

function Triage({ settings, onSave, notify, mailboxes = [] }) {
  const [rules, setRules] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [form, setForm] = useState({ key: '', name: '', kind: 'vip' });
  const set = (k) => (v) => onSave({ [k]: v });

  const load = () => {
    api('/sender-rules').then((r) => setRules(r.rules)).catch((e) => notify(e.message, 'error'));
    api('/vip-suggestions').then((r) => setSuggestions(r.suggestions || [])).catch(() => setSuggestions([]));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(e) {
    e.preventDefault();
    try {
      await api('/sender-rules', { method: 'POST', body: form });
      setForm({ key: '', name: '', kind: form.kind });
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function confirmVip(s) {
    try {
      await api('/sender-rules', { method: 'POST', body: { key: s.key, kind: 'vip', name: s.name || '' } });
      notify(`已设为 VIP：${s.name || s.key}`);
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function del(key) {
    await api('/sender-rules?key=' + encodeURIComponent(key), { method: 'DELETE' }).catch((e) => notify(e.message, 'error'));
    load();
  }

  const vip = (rules || []).filter((r) => r.kind === 'vip');
  const muted = (rules || []).filter((r) => r.kind === 'muted');

  return (
    <>
      <p className="set-desc">
        「今日待办」会把需要你回复的客户邮件按 <b>客户等级 × 邮件意图 × 等待时长</b> 自动排序。你发过邮件的联系人（及其公司域名）自动识别为老客户；
        订单、付款、投诉、紧急、询盘、样品、物流等中英文关键词会提高优先级；通知和订阅邮件自动降权。
      </p>
      <Choice icon={Hourglass} label="默认回复时限" value={settings.replySlaHours} onChange={set('replySlaHours')} options={[[4, '4 小时'], [8, '8 小时'], [24, '24 小时'], [48, '48 小时']]} />
      <div className="sla-tier-block">
        <div className="sla-tier-title"><Crown size={14} /> 分层 SLA（VIP / 客户 / 新询盘）</div>
        <p className="set-desc muted-note">超时标红与排序会按层级使用不同时限；未单独设置时回落到默认值。</p>
        <Choice icon={Crown} label="VIP 客户" value={settings.slaVipHours ?? 4} onChange={set('slaVipHours')} options={[[2, '2 小时'], [4, '4 小时'], [8, '8 小时'], [12, '12 小时']]} />
        <Choice icon={Hourglass} label="老客户" value={settings.slaCustomerHours ?? 24} onChange={set('slaCustomerHours')} options={[[8, '8 小时'], [12, '12 小时'], [24, '24 小时'], [48, '48 小时']]} />
        <Choice icon={Sparkles} label="新询盘" value={settings.slaNewInquiryHours ?? 8} onChange={set('slaNewInquiryHours')} options={[[4, '4 小时'], [8, '8 小时'], [12, '12 小时'], [24, '24 小时']]} />
      </div>
      <Choice icon={Send} label="对方未回复多久提醒跟进" value={settings.followupDays} onChange={set('followupDays')} options={[[2, '2 天'], [3, '3 天'], [5, '5 天'], [7, '7 天']]} />
      <Choice
        icon={Hand}
        label="发信后自动认领客户"
        value={settings.sendAutoClaim === 'off' ? 'off' : 'auto'}
        onChange={set('sendAutoClaim')}
        options={[['auto', '开启（推荐）'], ['off', '关闭']]}
      />
      <p className="set-desc muted-note">开启后，发信给外部客户会自动认领，减少「先回了却没认」导致的撞单；同事已认领时不会抢占，仅提示。</p>
      <Toggle icon={BellRing} label="超时提醒" desc="超时后分阶段提醒：首次 → 4 小时后升级 → 再 12 小时终提醒（有冷却，不全量轰炸）" checked={settings.remindOverdue} onChange={set('remindOverdue')} />

      <h4 className="set-h"><Crown size={15} /> VIP 建议（需确认）</h4>
      <p className="set-desc muted-note">根据往来频次与订单/付款/投诉信号给出建议，不会自动升 VIP。</p>
      {suggestions && !suggestions.length && <p className="set-desc muted-note">暂无建议。与客户往来增多后会出现在这里。</p>}
      {(suggestions || []).map((s) => (
        <div key={s.key} className="tpl-row vip-suggest-row">
          <span className="rule-ico vip"><Crown size={13} /></span>
          <div>
            <b>{s.name || s.key}</b>
            <small>{(s.reasons || []).join(' · ')} · {s.key.startsWith('@') ? `建议整域 ${s.key}` : s.key}</small>
          </div>
          <button type="button" className="btn-primary sm" onClick={() => confirmVip(s)}>确认 VIP</button>
        </div>
      ))}

      <h4 className="set-h"><Crown size={15} /> VIP 客户与静音名单</h4>
      <form className="rule-form" onSubmit={add}>
        <div className="segmented">
          <button type="button" className={form.kind === 'vip' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'vip' })}>VIP</button>
          <button type="button" className={form.kind === 'muted' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'muted' })}>静音</button>
        </div>
        <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="buyer@acme.com 或 @acme.com（整个公司）" required />
        {form.kind === 'vip' && <input className="short" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="客户名称（可选）" />}
        <button className="btn-primary sm"><Plus size={13} /> 添加</button>
      </form>
      {rules && !rules.length && <p className="set-desc muted-note">还没有规则。在阅读邮件时，也可以直接点发件人下方的「设为 VIP」。</p>}
      {[...vip, ...muted].map((r) => (
        <div key={r.key} className="tpl-row">
          <span className={'rule-ico ' + r.kind}>{r.kind === 'vip' ? <Crown size={13} /> : <BellOff size={13} />}</span>
          <div>
            <b>{r.name || r.key}</b>
            <small>{r.kind === 'vip' ? 'VIP 客户 · 始终置于最前' : '静音 · 不进入今日待办'} · {r.key.startsWith('@') ? `整个 ${r.key} 域名` : r.key}</small>
          </div>
          <button className="icon-btn danger" onClick={() => del(r.key)} title="移除"><Trash2 size={14} /></button>
        </div>
      ))}

      <MailRulesPanel notify={notify} mailboxes={mailboxes} />
    </>
  );
}

function Templates({ notify }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);

  const load = () => api('/templates').then((r) => setList(r.templates)).catch((e) => notify(e.message, 'error'));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    try {
      await api('/templates', { method: 'POST', body: edit });
      setEdit(null);
      load();
      notify('模板已保存');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function del(t) {
    if (!window.confirm(`删除模板「${t.name}」？`)) return;
    await api(`/templates/${t.id}`, { method: 'DELETE' }).catch((e) => notify(e.message, 'error'));
    load();
  }

  return (
    <>
      <p className="set-desc">常用回复、报价、开发信可以存成模板，写信时一键插入。正文中的 <code>{'{{name}}'}</code> 会自动替换为收件人称呼。</p>
      {edit ? (
        <div className="set-account">
          <label className="field"><span>模板名称</span><input value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <label className="field"><span>主题（可选）</span><input value={edit.subject || ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></label>
          <label className="field"><span>正文</span><textarea rows={8} value={edit.body || ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} placeholder={'Hi {{name}},\n\n...'} /></label>
          <div className="set-actions">
            <button className="btn-primary sm" onClick={save}>保存模板</button>
            <button className="btn-ghost sm" onClick={() => setEdit(null)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="btn-ghost" onClick={() => setEdit({ name: '', subject: '', body: '' })}><Plus size={15} /> 新建模板</button>
      )}
      {list?.map((t) => (
        <div key={t.id} className="tpl-row">
          <div>
            <b>{t.name}</b>
            <small>{t.subject || (t.body || '').slice(0, 60)}</small>
          </div>
          <button className="icon-btn" onClick={() => setEdit(t)} title="编辑"><Pencil size={14} /></button>
          <button className="icon-btn danger" onClick={() => del(t)} title="删除"><Trash2 size={14} /></button>
        </div>
      ))}
    </>
  );
}

function Account({ user, onUserChange, onLogout, notify }) {
  const [name, setName] = useState(user.name || '');
  const [pwd, setPwd] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [totpOn, setTotpOn] = useState(!!user.totpEnabled);
  const [totpSetup, setTotpSetup] = useState(null); // { qrDataUrl, secret }
  const [totpCode, setTotpCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState(null); // string[] 一次性展示
  const [recoveryLeft, setRecoveryLeft] = useState(null);

  function loadSessions() {
    api('/me/sessions')
      .then((d) => {
        setSessions(d.sessions || []);
        setPolicy(d.policy || null);
      })
      .catch(() => setSessions([]));
  }

  useEffect(() => {
    loadSessions();
    api('/me/totp')
      .then((d) => {
        setTotpOn(!!d.enabled);
        setRecoveryLeft(d.recoveryLeft ?? null);
      })
      .catch(() => {});
  }, []);

  async function saveName() {
    try {
      await api('/me', { method: 'PATCH', body: { name } });
      onUserChange({ ...user, name });
      notify('已保存');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function changePwd(e) {
    e.preventDefault();
    if (pwd.newPassword !== pwd.confirm) return notify('两次输入的新密码不一致', 'error');
    setBusy(true);
    try {
      await api('/me/password', { method: 'POST', body: pwd });
      setPwd({ oldPassword: '', newPassword: '', confirm: '' });
      notify('密码已修改，其他设备上的登录已失效');
      loadSessions();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    if (!window.confirm('确定注销其他设备上的登录？当前浏览器仍保持登录。')) return;
    setRevoking(true);
    try {
      const d = await api('/me/sessions/revoke-others', { method: 'POST', body: {} });
      notify(`已注销 ${d.revoked || 0} 个其他会话`, 'success');
      loadSessions();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setRevoking(false);
    }
  }

  const otherCount = (sessions || []).filter((s) => !s.current).length;

  return (
    <>
      <div className="set-account">
        <label className="field"><span>平台登录账号</span><input value={user.email} disabled /></label>
        <label className="field"><span>姓名</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="set-actions"><button className="btn-primary sm" disabled={name === user.name} onClick={saveName}>保存</button></div>
      </div>
      <form className="set-account" onSubmit={changePwd}>
        <h4><KeyRound size={15} /> 修改登录密码</h4>
        <label className="field"><span>当前密码</span><input type="password" required value={pwd.oldPassword} onChange={(e) => setPwd({ ...pwd, oldPassword: e.target.value })} autoComplete="current-password" /></label>
        <div className="row-2">
          <label className="field"><span>新密码（至少 8 位，含字母和数字）</span><input type="password" required minLength={8} value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })} autoComplete="new-password" /></label>
          <label className="field"><span>确认新密码</span><input type="password" required value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} autoComplete="new-password" /></label>
        </div>
        <div className="set-actions"><button className="btn-primary sm" disabled={busy}>{busy && <Loader2 size={13} className="spin" />} 修改密码</button></div>
      </form>
      <div className="set-account">
        <h4><ShieldCheck size={15} /> 二次验证（TOTP）</h4>
        {user.role === 'admin' && !totpOn && (
          <div className="ai-status-card off" style={{ marginBottom: 10 }}>
            <b>管理员建议开启二次验证</b>
            <small>管理员可重置他人密码与查看运维信息，开启 TOTP 可显著降低账号被盗风险。</small>
          </div>
        )}
        <p className="set-hint">
          {totpOn
            ? '已开启：登录时除密码外还需验证器动态码（推荐管理员开启）。'
            : '可选：用 Google Authenticator / 微软验证器等 App 增加一层登录保护。'}
        </p>
        {!totpOn && !totpSetup && (
          <div className="set-actions">
            <button
              type="button"
              className="btn-primary sm"
              disabled={totpBusy}
              onClick={async () => {
                setTotpBusy(true);
                try {
                  const d = await api('/me/totp/setup', { method: 'POST', body: {} });
                  setTotpSetup(d);
                  setTotpCode('');
                } catch (e) {
                  notify(e.message, 'error');
                } finally {
                  setTotpBusy(false);
                }
              }}
            >
              {totpBusy ? <Loader2 size={13} className="spin" /> : null}
              开始绑定验证器
            </button>
          </div>
        )}
        {totpSetup && (
          <div className="totp-setup">
            <img src={totpSetup.qrDataUrl} alt="TOTP QR" width={160} height={160} />
            <p className="set-hint">用手机验证器扫描二维码，或手动输入密钥：<code>{totpSetup.secret}</code></p>
            <label className="field">
              <span>输入验证器中的 6 位码以确认开启</span>
              <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" placeholder="6 位动态码" />
            </label>
            <div className="set-actions">
              <button
                type="button"
                className="btn-primary sm"
                disabled={totpBusy || totpCode.replace(/\s/g, '').length < 6}
                onClick={async () => {
                  setTotpBusy(true);
                  try {
                    const r = await api('/me/totp/confirm', { method: 'POST', body: { code: totpCode } });
                    setTotpOn(true);
                    setTotpSetup(null);
                    setRecoveryCodes(r.recoveryCodes || null);
                    setRecoveryLeft((r.recoveryCodes || []).length);
                    onUserChange({ ...user, totpEnabled: true });
                    notify('二次验证已开启，请立刻保存备用码', 'success');
                  } catch (e) {
                    notify(e.message, 'error');
                  } finally {
                    setTotpBusy(false);
                  }
                }}
              >
                确认开启
              </button>
              <button type="button" className="btn-ghost sm" onClick={() => setTotpSetup(null)}>取消</button>
            </div>
          </div>
        )}
        {recoveryCodes?.length > 0 && (
          <div className="recovery-codes">
            <p className="set-hint"><b>备用恢复码（只显示一次）</b>：手机丢失时可用其中一条登录或关闭二次验证。请抄写并妥善保存。</p>
            <ul>
              {recoveryCodes.map((c) => (
                <li key={c}><code>{c}</code></li>
              ))}
            </ul>
            <div className="set-actions">
              <button
                type="button"
                className="btn-ghost sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
                    notify('已复制到剪贴板', 'success');
                  } catch {
                    notify('复制失败，请手动抄写', 'error');
                  }
                }}
              >
                复制全部
              </button>
              <button type="button" className="btn-ghost sm" onClick={() => setRecoveryCodes(null)}>我已保存</button>
            </div>
          </div>
        )}
        {totpOn && (
          <div className="set-actions">
            {recoveryLeft != null && (
              <span className="set-hint" style={{ flex: '1 1 100%' }}>剩余备用码 {recoveryLeft} 条</span>
            )}
            <button
              type="button"
              className="btn-ghost sm"
              disabled={totpBusy}
              onClick={async () => {
                const code = window.prompt('输入验证器 6 位码（或一条备用码）以重新生成备用码');
                if (!code) return;
                setTotpBusy(true);
                try {
                  const r = await api('/me/totp/recovery', { method: 'POST', body: { code } });
                  setRecoveryCodes(r.recoveryCodes || null);
                  setRecoveryLeft(r.recoveryLeft ?? null);
                  notify('已生成新的备用码，请保存', 'success');
                } catch (e) {
                  notify(e.message, 'error');
                } finally {
                  setTotpBusy(false);
                }
              }}
            >
              重新生成备用码
            </button>
            <button
              type="button"
              className="btn-ghost sm danger"
              disabled={totpBusy}
              onClick={async () => {
                const code = window.prompt('请输入验证器 6 位码或备用码以关闭二次验证');
                if (!code) return;
                setTotpBusy(true);
                try {
                  await api('/me/totp/disable', { method: 'POST', body: { code } });
                  setTotpOn(false);
                  setRecoveryCodes(null);
                  setRecoveryLeft(0);
                  onUserChange({ ...user, totpEnabled: false });
                  notify('二次验证已关闭');
                } catch (e) {
                  notify(e.message, 'error');
                } finally {
                  setTotpBusy(false);
                }
              }}
            >
              关闭二次验证
            </button>
          </div>
        )}
      </div>
      <div className="set-account">
        <h4><ShieldCheck size={15} /> 登录设备</h4>
        <p className="set-hint">
          空闲 {policy?.idleDays ?? 14} 天未使用将自动失效；单次登录最长 {policy?.absDays ?? 30} 天。
        </p>
        {sessions == null && <div className="muted"><Loader2 size={14} className="spin" /> 加载会话…</div>}
        {sessions && (
          <ul className="session-list">
            {sessions.map((s, i) => (
              <li key={i} className={s.current ? 'current' : ''}>
                <b>{s.current ? '当前设备' : '其他设备'}</b>
                <span>{s.userAgent ? s.userAgent.slice(0, 72) : '未知浏览器'}</span>
                <small>最近活动 {relativeTime(s.lastSeen)}</small>
              </li>
            ))}
          </ul>
        )}
        <div className="set-actions">
          <button type="button" className="btn-ghost sm" disabled={revoking || !otherCount} onClick={revokeOthers}>
            {revoking ? <Loader2 size={13} className="spin" /> : null}
            注销其他设备{otherCount ? `（${otherCount}）` : ''}
          </button>
        </div>
      </div>
      <button className="btn-ghost danger" onClick={onLogout}><LogOut size={15} /> 退出登录</button>
    </>
  );
}

function OauthOps({ notify }) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    api('/oauth/status')
      .then(setSt)
      .catch((e) => notify?.(e.message, 'error'));
  }, [notify]);
  if (!st) return null;
  return (
    <div className="oauth-ops">
      <h3 className="set-h">Gmail / Microsoft OAuth</h3>
      <p className="set-desc">
        配置生产环境变量后绑定页出现一键授权。步骤见仓库 <code>docs/oauth-setup.md</code>。
      </p>
      <div className="ops-flags">
        <span className={st.ready ? 'ok' : 'warn'}>{st.ready ? '已就绪' : '未就绪'}</span>
        <span className={st.gmail ? 'ok' : 'mute'}>Gmail {st.gmail ? '开' : '关'}</span>
        <span className={st.microsoft ? 'ok' : 'mute'}>M365 {st.microsoft ? '开' : '关'}</span>
        <span className={st.publicBase ? 'ok' : 'warn'}>回调根 {st.publicBase || '未设 PUBLIC_BASE_URL'}</span>
      </div>
      {(st.missing || []).length > 0 && (
        <div className="form-error">缺少：{st.missing.join('、')}</div>
      )}
      {(st.redirects?.gmail || st.redirects?.microsoft) && (
        <ul className="oauth-redirects">
          {st.redirects.gmail && <li><b>Gmail 回调</b> <code>{st.redirects.gmail}</code></li>}
          {st.redirects.microsoft && <li><b>M365 回调</b> <code>{st.redirects.microsoft}</code></li>}
        </ul>
      )}
    </div>
  );
}

function Team({ me, notify }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);

  const load = () => api('/admin/users').then((r) => setList(r.users)).catch((e) => notify(e.message, 'error'));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e) {
    e.preventDefault();
    const pwd = String(form.password || '');
    if (pwd.length < 8 || !/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) {
      notify('密码至少 8 位，且需同时包含字母和数字', 'error');
      return;
    }
    try {
      await api('/admin/users', { method: 'POST', body: form });
      const cred = `${form.email}\n${pwd}`;
      notify(`已创建 ${form.email}，请把密码发给对方`, 'success', {
        label: '复制账号密码',
        fn: () => {
          navigator.clipboard?.writeText(cred).then(
            () => notify('已复制到剪贴板', 'success'),
            () => notify('复制失败，请手动告知对方', 'error')
          );
        },
      }, 12_000);
      setForm(null);
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function reset(u) {
    const password = window.prompt(`为 ${u.email} 设置新密码（至少 8 位，含字母和数字）`);
    if (!password) return;
    try {
      await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password } });
      notify('密码已重置');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function del(u) {
    if (!window.confirm(`删除成员 ${u.email}？其绑定的 ${u.mailboxes} 个邮箱也会一并解绑。`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  return (
    <>
      <OauthOps notify={notify} />
      <p className="set-desc">为同事开通平台账号。每位成员登录后各自绑定、管理自己的邮箱，彼此数据隔离。</p>
      {form ? (
        <form className="set-account" onSubmit={create}>
          <div className="row-2">
            <label className="field"><span>登录账号</span><input required placeholder="用户名或邮箱" autoCapitalize="none" spellCheck={false} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus /></label>
            <label className="field"><span>姓名</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
          <div className="row-2">
            <label className="field"><span>初始密码（≥8 位，字母+数字）</span><input required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
            <label className="field">
              <span>角色</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
            </label>
          </div>
          <div className="set-actions">
            <button className="btn-primary sm">创建账号</button>
            <button type="button" className="btn-ghost sm" onClick={() => setForm(null)}>取消</button>
          </div>
        </form>
      ) : (
        <button className="btn-ghost" onClick={() => setForm({ email: '', name: '', password: '', role: 'member' })}><Plus size={15} /> 添加成员</button>
      )}
      {list?.map((u) => (
        <div key={u.id} className="tpl-row">
          <div>
            <b>{u.name} {u.role === 'admin' && <em className="pill">管理员</em>}</b>
            <small>{u.email} · 绑定 {u.mailboxes} 个邮箱</small>
          </div>
          <button className="icon-btn" onClick={() => reset(u)} title="重置密码"><KeyRound size={14} /></button>
          {u.id !== me.id && <button className="icon-btn danger" onClick={() => del(u)} title="删除"><Trash2 size={14} /></button>}
        </div>
      ))}
    </>
  );
}


function LabelsPanel({ notify, onChanged }) {
  const [list, setList] = useState(null);
  const [colors, setColors] = useState(DEFAULT_LABEL_COLORS);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_LABEL_COLORS[0]);
  const [busy, setBusy] = useState('');
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  async function load() {
    try {
      const d = await api('/labels');
      setList(d.labels || []);
      if (d.colors?.length) setColors(d.colors);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy('create');
    try {
      const d = await api('/labels', { method: 'POST', body: { name: name.trim(), color } });
      setList(d.labels);
      setName('');
      notify('标签已创建');
      onChanged?.(d.labels);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function saveEdit(id) {
    setBusy('edit');
    try {
      const d = await api(`/labels/${id}`, { method: 'PATCH', body: { name: editName.trim(), color: editColor } });
      setList(d.labels);
      setEditId(null);
      notify('已保存');
      onChanged?.(d.labels);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function remove(l) {
    if (!window.confirm(`删除标签「${l.name}」？\n标签将从所有邮件移除，邮件本身不会删除。`)) return;
    try {
      const d = await api(`/labels/${l.id}`, { method: 'DELETE' });
      setList(d.labels);
      notify('标签已删除');
      onChanged?.(d.labels);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function presets() {
    setBusy('presets');
    try {
      const d = await api('/labels/presets', { method: 'POST', body: {} });
      setList(d.labels);
      const n = d.created?.length || 0;
      notify(n ? `已添加 ${n} 个推荐标签` : '推荐标签已存在');
      onChanged?.(d.labels);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="set-row">
        <div>
          <b>邮件标签</b>
          <small>用标签整理询盘、样品、大货，不影响文件夹。可与搜索 label:名称 配合。</small>
        </div>
        <button type="button" className="btn-ghost sm" disabled={busy === 'presets'} onClick={presets}>
          {busy === 'presets' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 添加外贸推荐
        </button>
      </div>

      <form className="glossary-add label-create-form" onSubmit={create}>
        <span className="label-dot lg" style={{ background: color }} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新标签名称" maxLength={40} />
        <div className="label-color-picks" role="group" aria-label="颜色">
          {colors.map((c) => (
            <button key={c} type="button" className={'label-color-swatch' + (color === c ? ' on' : '')} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
          ))}
        </div>
        <button type="submit" className="btn-primary sm" disabled={busy === 'create' || !name.trim()}>创建</button>
      </form>

      {!list && <div className="muted">加载中…</div>}
      {list && !list.length && (
        <div className="empty-inline">还没有标签。可点「添加外贸推荐」一键创建询盘、样品、大货等。</div>
      )}
      {list?.map((l) => (
        <div key={l.id} className="tpl-row label-manage-row">
          {editId === l.id ? (
            <>
              <span className="label-dot" style={{ background: editColor }} />
              <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={40} />
              <div className="label-color-picks">
                {colors.map((c) => (
                  <button key={c} type="button" className={'label-color-swatch' + (editColor === c ? ' on' : '')} style={{ background: c }} onClick={() => setEditColor(c)} />
                ))}
              </div>
              <button type="button" className="btn-primary sm" onClick={() => saveEdit(l.id)}>保存</button>
              <button type="button" className="btn-ghost sm" onClick={() => setEditId(null)}>取消</button>
            </>
          ) : (
            <>
              <span className="label-dot" style={{ background: l.color }} />
              <div>
                <b>{l.name}</b>
                <small>{l.count || 0} 封邮件</small>
              </div>
              <button type="button" className="icon-btn" title="编辑" onClick={() => { setEditId(l.id); setEditName(l.name); setEditColor(l.color); }}><Pencil size={14} /></button>
              <button type="button" className="icon-btn danger" title="删除" onClick={() => remove(l)}><Trash2 size={14} /></button>
            </>
          )}
        </div>
      ))}
    </>
  );
}

export default function Settings({ user, mailboxes, tab: initialTab, focusMailbox, onClose, notify, onUserChange, onSettings, onMailboxesChanged, onAddMailbox, onLogout, aiEnabled, aiMeta, onAiCloudChange, onLabelsChanged }) {
  const [tab, setTab] = useState(initialTab || 'mailboxes');
  const tabs = TABS.filter(([k]) => k !== 'team' || user.role === 'admin');

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>设置</b>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav">
            {tabs.map(([k, l, Icon]) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><Icon size={15} /> {l}</button>
            ))}
          </nav>
          <div className="modal-body settings-body">
            {tab === 'mailboxes' && <Mailboxes mailboxes={mailboxes} onChanged={onMailboxesChanged} onAdd={onAddMailbox} notify={notify} focusId={focusMailbox} />}
            {tab === 'triage' && <Triage settings={user.settings} onSave={onSettings} notify={notify} mailboxes={mailboxes} />}
            {tab === 'labels' && <LabelsPanel notify={notify} onChanged={onLabelsChanged} />}
            {tab === 'contacts' && <ContactsPanel notify={notify} />}
            {tab === 'preferences' && (
              <Preferences
                settings={user.settings}
                onSave={onSettings}
                aiEnabled={aiEnabled}
                aiMeta={aiMeta}
                onAiCloudChange={onAiCloudChange}
                notify={notify}
              />
            )}
            {tab === 'templates' && <Templates notify={notify} />}
            {tab === 'account' && <Account user={user} onUserChange={onUserChange} onLogout={onLogout} notify={notify} />}
            {tab === 'team' && <Team me={user} notify={notify} />}
          </div>
        </div>
      </div>
    </div>
  );
}