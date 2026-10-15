import React, { useEffect, useState } from 'react';
import {
  X, Trash2, Plus, Moon, Sun, Bell, Sparkles, RefreshCw, ArrowUp, ArrowDown, Server, Loader2, AlertCircle, CheckCircle2, Mail,
  SlidersHorizontal, FileStack, User, Users, Pencil, LogOut, Image, Undo2, MessagesSquare, Rows3, KeyRound, ListTodo, Hourglass, Send,
  BellRing, Crown, BellOff,
} from 'lucide-react';
import { api } from '../api.js';
import { MAILBOX_COLORS, relativeTime } from '../utils.js';
import MailboxForm from './MailboxForm.jsx';

const TABS = [
  ['mailboxes', '邮箱账号', Mail],
  ['triage', '智能分拣', ListTodo],
  ['preferences', '偏好设置', SlidersHorizontal],
  ['templates', '邮件模板', FileStack],
  ['account', '账户与安全', User],
  ['team', '团队成员', Users],
];

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
        <button className="btn-ghost sm" onClick={() => setEditConn((v) => !v)}><Server size={13} /> 密码与服务器</button>
        <span className="spacer" />
        <button className="btn-ghost sm danger" onClick={remove}><Trash2 size={13} /> 解绑</button>
      </div>
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

function Preferences({ settings, onSave }) {
  const set = (k) => (v) => {
    onSave({ [k]: v });
    if (k === 'notify' && v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  };
  return (
    <>
      <Choice icon={settings.theme === 'dark' ? Moon : Sun} label="外观" value={settings.theme} onChange={set('theme')} options={[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]} />
      <Choice icon={Rows3} label="列表密度" value={settings.density} onChange={set('density')} options={[['comfortable', '舒适'], ['compact', '紧凑']]} />
      <Choice icon={Image} label="外部图片" value={settings.remoteImages} onChange={set('remoteImages')} options={[['always', '总是显示'], ['contacts', '仅联系人'], ['never', '询问']]} />
      <Choice icon={Undo2} label="撤销发送时长" value={settings.undoSeconds} onChange={set('undoSeconds')} options={[[0, '关闭'], [5, '5 秒'], [10, '10 秒'], [20, '20 秒'], [30, '30 秒']]} />
      <Toggle icon={MessagesSquare} label="会话视图" desc="把同一主题的往来邮件合并展示" checked={settings.conversationView} onChange={set('conversationView')} />
      <Toggle icon={Sparkles} label="打开邮件时自动生成 AI 摘要" checked={settings.autoSummary} onChange={set('autoSummary')} />
      <Toggle icon={Bell} label="新邮件桌面通知" desc="浏览器在后台时弹出系统通知" checked={settings.notify} onChange={set('notify')} />
    </>
  );
}

function Triage({ settings, onSave, notify }) {
  const [rules, setRules] = useState(null);
  const [form, setForm] = useState({ key: '', name: '', kind: 'vip' });
  const set = (k) => (v) => onSave({ [k]: v });

  const load = () => api('/sender-rules').then((r) => setRules(r.rules)).catch((e) => notify(e.message, 'error'));
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
      <Choice icon={Hourglass} label="回复时限" value={settings.replySlaHours} onChange={set('replySlaHours')} options={[[4, '4 小时'], [8, '8 小时'], [24, '24 小时'], [48, '48 小时']]} />
      <Choice icon={Send} label="对方未回复多久提醒跟进" value={settings.followupDays} onChange={set('followupDays')} options={[[2, '2 天'], [3, '3 天'], [5, '5 天'], [7, '7 天']]} />
      <Toggle icon={BellRing} label="超时提醒" desc="客户邮件超过回复时限仍未处理时主动提醒（每封只提醒一次）" checked={settings.remindOverdue} onChange={set('remindOverdue')} />

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
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

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
          <label className="field"><span>新密码（至少 8 位）</span><input type="password" required minLength={8} value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })} autoComplete="new-password" /></label>
          <label className="field"><span>确认新密码</span><input type="password" required value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} autoComplete="new-password" /></label>
        </div>
        <div className="set-actions"><button className="btn-primary sm" disabled={busy}>{busy && <Loader2 size={13} className="spin" />} 修改密码</button></div>
      </form>
      <button className="btn-ghost danger" onClick={onLogout}><LogOut size={15} /> 退出登录</button>
    </>
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
    try {
      await api('/admin/users', { method: 'POST', body: form });
      notify(`已创建账号 ${form.email}，请把登录密码告知对方`);
      setForm(null);
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function reset(u) {
    const password = window.prompt(`为 ${u.email} 设置新密码（至少 8 位）`);
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
      <p className="set-desc">为同事开通平台账号。每位成员登录后各自绑定、管理自己的邮箱，彼此数据隔离。</p>
      {form ? (
        <form className="set-account" onSubmit={create}>
          <div className="row-2">
            <label className="field"><span>登录账号</span><input required placeholder="用户名或邮箱" autoCapitalize="none" spellCheck={false} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus /></label>
            <label className="field"><span>姓名</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
          <div className="row-2">
            <label className="field"><span>初始密码（至少 8 位）</span><input required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
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

export default function Settings({ user, mailboxes, tab: initialTab, focusMailbox, onClose, notify, onUserChange, onSettings, onMailboxesChanged, onAddMailbox, onLogout }) {
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
            {tab === 'triage' && <Triage settings={user.settings} onSave={onSettings} notify={notify} />}
            {tab === 'preferences' && <Preferences settings={user.settings} onSave={onSettings} />}
            {tab === 'templates' && <Templates notify={notify} />}
            {tab === 'account' && <Account user={user} onUserChange={onUserChange} onLogout={onLogout} notify={notify} />}
            {tab === 'team' && <Team me={user} notify={notify} />}
          </div>
        </div>
      </div>
    </div>
  );
}