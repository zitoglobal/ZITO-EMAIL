import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus, Trash2, Pencil, Loader2, ChevronUp, ChevronDown, Filter, Power, X, Sparkles,
} from 'lucide-react';
import { api } from '../api.js';
import { relativeTime } from '../utils.js';

const EMPTY_COND = { field: 'from', op: 'contains', value: '' };
const EMPTY_ACTION = { type: 'apply_label', params: {} };

const CATEGORY_OPTS = [
  ['people', '人际'],
  ['notification', '通知'],
  ['newsletter', '订阅'],
];

function defaultOp(field) {
  if (field === 'from') return 'contains';
  if (field === 'subject' || field === 'keyword') return 'contains';
  return 'is';
}

function condPreview(c) {
  if (!c) return '';
  if (c.field === 'from' && c.op === 'domain') return `来自 ${c.value}`;
  if (c.field === 'from' && c.op === 'is') return `来自 ${c.value}`;
  if (c.field === 'from') return `发件人含 ${c.value}`;
  if (c.field === 'subject' && c.op === 'not_contains') return `主题不含「${c.value}」`;
  if (c.field === 'subject') return `主题含「${c.value}」`;
  if (c.field === 'has_att') return c.value === false ? '无附件' : '有附件';
  if (c.field === 'to_me') return '收件人是我';
  if (c.field === 'category') return `分类 · ${CATEGORY_OPTS.find(([k]) => k === c.value)?.[1] || c.value}`;
  if (c.field === 'keyword') return `含「${c.value}」`;
  if (c.field === 'mailbox_id') return `账号 ${c.value}`;
  return `${c.field}`;
}

function actionPreview(a, labelMap) {
  if (!a) return '';
  switch (a.type) {
    case 'apply_label':
      return `贴标「${labelMap[a.params?.labelId] || a.params?.labelId || '…'}」`;
    case 'mark_read':
      return '标已读';
    case 'star':
      return '星标';
    case 'skip_inbox':
      return '跳过收件箱';
    case 'move_folder':
      return `移到 ${a.params?.folder || '…'}`;
    case 'archive':
      return '归档';
    case 'mark_vip':
      return '标为 VIP';
    case 'mute_sender':
      return '静音发件人';
    default:
      return a.type;
  }
}

export default function MailRulesPanel({ notify, mailboxes = [] }) {
  const [rules, setRules] = useState(null);
  const [labels, setLabels] = useState([]);
  const [meta, setMeta] = useState({ conditionFields: [], actionTypes: [] });
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | rule
  const [foldersByMb, setFoldersByMb] = useState({});

  async function load() {
    try {
      const [r, l, s] = await Promise.all([api('/mail-rules'), api('/labels'), api('/state')]);
      setRules(r.rules || []);
      setMeta({ conditionFields: r.conditionFields || [], actionTypes: r.actionTypes || [] });
      setLabels(l.labels || []);
      if (s.folders) setFoldersByMb(s.folders);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labelMap = useMemo(() => Object.fromEntries(labels.map((l) => [l.id, l.name])), [labels]);
  const enabledCount = (rules || []).filter((r) => r.enabled).length;

  async function ensureFolders(mailboxId) {
    if (Object.keys(foldersByMb).length) return;
    try {
      const d = await api('/state');
      setFoldersByMb(d.folders || {});
    } catch {
      /* ignore */
    }
  }

  function openNew() {
    setEditing({
      id: null,
      name: '',
      enabled: true,
      stopProcessing: false,
      conditions: [{ ...EMPTY_COND }],
      actions: [{ ...EMPTY_ACTION }],
    });
  }

  function openEdit(rule) {
    setEditing({
      id: rule.id,
      name: rule.name || '',
      enabled: rule.enabled,
      stopProcessing: !!rule.stopProcessing,
      conditions: (rule.conditions || []).map((c) => ({ ...c })),
      actions: (rule.actions || []).map((a) => ({ type: a.type, params: { ...(a.params || {}) } })),
    });
    const mb = rule.conditions?.find((c) => c.field === 'mailbox_id')?.value || mailboxes[0]?.id;
    if (mb) ensureFolders(mb);
  }

  async function save() {
    if (!editing) return;
    setBusy('save');
    try {
      const body = {
        name: editing.name,
        enabled: editing.enabled,
        stopProcessing: editing.stopProcessing,
        conditions: editing.conditions,
        actions: editing.actions,
      };
      const d = editing.id
        ? await api(`/mail-rules/${editing.id}`, { method: 'PATCH', body })
        : await api('/mail-rules', { method: 'POST', body });
      setRules(d.rules);
      setEditing(null);
      notify('规则已保存');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function toggle(rule) {
    try {
      const d = await api(`/mail-rules/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
      setRules(d.rules);
      notify(rule.enabled ? '已停用' : '已启用');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function remove(rule) {
    if (!window.confirm(`删除规则「${rule.name || '未命名'}」？\n删除后不可恢复。历史已处理的邮件不会撤销。`)) return;
    try {
      const d = await api(`/mail-rules/${rule.id}`, { method: 'DELETE' });
      setRules(d.rules);
      notify('规则已删除');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function move(rule, dir) {
    if (!rules?.length) return;
    const ids = rules.map((r) => r.id);
    const i = ids.indexOf(rule.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      const d = await api('/mail-rules/reorder', { method: 'PUT', body: { ids } });
      setRules(d.rules);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  function setCond(i, patch) {
    setEditing((ed) => {
      const conditions = ed.conditions.map((c, idx) => {
        if (idx !== i) return c;
        const next = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          next.op = defaultOp(patch.field);
          next.value = patch.field === 'has_att' || patch.field === 'to_me' ? true : patch.field === 'category' ? 'people' : '';
        }
        return next;
      });
      return { ...ed, conditions };
    });
  }

  function setAction(i, patch) {
    setEditing((ed) => {
      const actions = ed.actions.map((a, idx) => {
        if (idx !== i) return a;
        if (patch.type && patch.type !== a.type) return { type: patch.type, params: {} };
        return { ...a, ...patch, params: { ...a.params, ...(patch.params || {}) } };
      });
      return { ...ed, actions };
    });
  }

  const folderOptions = useMemo(() => {
    const out = [];
    for (const mb of mailboxes) {
      const fs = foldersByMb[mb.id] || [];
      for (const f of fs) {
        if (['\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse)) continue;
        out.push({ mailboxId: mb.id, path: f.path, label: `${mb.email} · ${f.name || f.path}` });
      }
    }
    return out;
  }, [mailboxes, foldersByMb]);

  useEffect(() => {
    if (!editing) return;
    if (editing.actions.some((a) => a.type === 'move_folder' || a.type === 'archive')) {
      mailboxes.forEach((mb) => ensureFolders(mb.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.actions?.map((a) => a.type).join(','), mailboxes.length]);

  return (
    <div className="mail-rules-block">
      <h4 className="set-h"><Filter size={15} /> 邮件规则</h4>
      <p className="set-desc muted-note">
        复杂条件（主题含报价、有附件等）请用邮件规则；VIP / 静音仍可在上方快速添加。
        规则按从上到下匹配；即使「跳过收件箱」，VIP 来信仍会进入收件箱与今日待办。
      </p>
      <div className="set-row mail-rules-head">
        <div>
          <b>已启用 {enabledCount} 条</b>
          <small>新信入站时自动执行；不对历史邮件默认生效。</small>
        </div>
        {!editing && (
          <button type="button" className="btn-primary sm" onClick={openNew}>
            <Plus size={13} /> 新建规则
          </button>
        )}
      </div>

      {editing && (
        <div className="mail-rule-editor">
          <div className="mail-rule-editor-head">
            <b>{editing.id ? '编辑规则' : '新建规则'}</b>
            <button type="button" className="icon-btn" onClick={() => setEditing(null)} aria-label="关闭"><X size={16} /></button>
          </div>
          <label className="field">
            <span>名称（可选）</span>
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="留空则按条件自动命名"
              maxLength={80}
            />
          </label>

          <div className="mail-rule-section">
            <div className="mail-rule-section-title">若满足（全部条件）</div>
            {editing.conditions.map((c, i) => (
              <div key={i} className="mail-rule-row">
                <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} aria-label="条件字段">
                  {(meta.conditionFields.length ? meta.conditionFields : [
                    { value: 'from', label: '发件人' },
                    { value: 'subject', label: '主题' },
                    { value: 'has_att', label: '有附件' },
                    { value: 'to_me', label: '收件人是我' },
                    { value: 'category', label: '系统分类' },
                    { value: 'keyword', label: '关键词' },
                    { value: 'mailbox_id', label: '邮箱账号' },
                  ]).map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                {c.field === 'from' && (
                  <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                    <option value="contains">包含</option>
                    <option value="is">是</option>
                    <option value="domain">域名是</option>
                  </select>
                )}
                {c.field === 'subject' && (
                  <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                    <option value="contains">包含</option>
                    <option value="not_contains">不包含</option>
                  </select>
                )}
                {(c.field === 'has_att' || c.field === 'to_me') && (
                  <select value={c.value === false ? '0' : '1'} onChange={(e) => setCond(i, { op: 'is', value: e.target.value === '1' })}>
                    <option value="1">是</option>
                    <option value="0">否</option>
                  </select>
                )}
                {c.field === 'category' && (
                  <select value={c.value || 'people'} onChange={(e) => setCond(i, { op: 'is', value: e.target.value })}>
                    {CATEGORY_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
                {c.field === 'mailbox_id' && (
                  <select
                    value={c.value || ''}
                    onChange={(e) => {
                      setCond(i, { op: 'is', value: e.target.value });
                      ensureFolders(e.target.value);
                    }}
                  >
                    <option value="">选择账号</option>
                    {mailboxes.map((mb) => <option key={mb.id} value={mb.id}>{mb.email}</option>)}
                  </select>
                )}
                {['from', 'subject', 'keyword'].includes(c.field) && (
                  <input
                    value={c.value || ''}
                    onChange={(e) => setCond(i, { value: e.target.value })}
                    placeholder={c.field === 'from' && c.op === 'domain' ? '@acme.com' : c.field === 'from' && c.op === 'is' ? 'buyer@acme.com' : '输入内容'}
                  />
                )}
                <button
                  type="button"
                  className="icon-btn danger"
                  disabled={editing.conditions.length <= 1}
                  onClick={() => setEditing({ ...editing, conditions: editing.conditions.filter((_, j) => j !== i) })}
                  aria-label="删除条件"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-ghost sm"
              onClick={() => setEditing({ ...editing, conditions: [...editing.conditions, { ...EMPTY_COND }] })}
            >
              <Plus size={13} /> 且条件
            </button>
            <p className="hint-line">将匹配：{editing.conditions.map(condPreview).filter(Boolean).join(' 且 ') || '…'}</p>
          </div>

          <div className="mail-rule-section">
            <div className="mail-rule-section-title">则执行</div>
            {editing.actions.map((a, i) => (
              <div key={i} className="mail-rule-row">
                <select value={a.type} onChange={(e) => setAction(i, { type: e.target.value })} aria-label="动作类型">
                  {(meta.actionTypes.length ? meta.actionTypes : [
                    { value: 'apply_label', label: '贴标签' },
                    { value: 'mark_read', label: '标为已读' },
                    { value: 'star', label: '加星标' },
                    { value: 'skip_inbox', label: '跳过收件箱' },
                    { value: 'move_folder', label: '移到文件夹' },
                    { value: 'archive', label: '归档' },
                    { value: 'mark_vip', label: '标为 VIP' },
                    { value: 'mute_sender', label: '静音发件人' },
                  ]).map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                {a.type === 'apply_label' && (
                  <select
                    value={a.params?.labelId || ''}
                    onChange={(e) => setAction(i, { params: { labelId: Number(e.target.value) } })}
                  >
                    <option value="">选择标签</option>
                    {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                )}
                {a.type === 'move_folder' && (
                  <select
                    value={a.params?.folder || ''}
                    onChange={(e) => setAction(i, { params: { folder: e.target.value } })}
                    onFocus={() => mailboxes.forEach((mb) => ensureFolders(mb.id))}
                  >
                    <option value="">选择文件夹</option>
                    {folderOptions.map((f) => (
                      <option key={f.mailboxId + f.path} value={f.path}>{f.label}</option>
                    ))}
                  </select>
                )}
                {a.type === 'skip_inbox' && (
                  <small className="mail-rule-hint">VIP 来信仍会破窗进入收件箱</small>
                )}
                <button
                  type="button"
                  className="icon-btn danger"
                  disabled={editing.actions.length <= 1}
                  onClick={() => setEditing({ ...editing, actions: editing.actions.filter((_, j) => j !== i) })}
                  aria-label="删除动作"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-ghost sm"
              onClick={() => setEditing({ ...editing, actions: [...editing.actions, { ...EMPTY_ACTION }] })}
            >
              <Plus size={13} /> 添加动作
            </button>
          </div>

          <label className="toggle-row mail-rule-stop">
            <input
              type="checkbox"
              checked={!!editing.stopProcessing}
              onChange={(e) => setEditing({ ...editing, stopProcessing: e.target.checked })}
            />
            <span>匹配后不再执行后面的规则</span>
          </label>

          <div className="set-actions">
            <button type="button" className="btn-primary sm" disabled={busy === 'save'} onClick={save}>
              {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 保存
            </button>
            <button type="button" className="btn-ghost sm" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      {!rules && <div className="muted">加载中…</div>}
      {rules && !rules.length && !editing && (
        <div className="empty-inline">还没有邮件规则。用规则自动贴标签、归档或跳过收件箱。</div>
      )}
      {rules?.map((r, idx) => (
        <div key={r.id} className={'tpl-row mail-rule-list-row' + (r.enabled ? '' : ' off')}>
          <div className="mail-rule-order">
            <button type="button" className="icon-btn" disabled={idx === 0} onClick={() => move(r, -1)} title="上移" aria-label="上移"><ChevronUp size={14} /></button>
            <button type="button" className="icon-btn" disabled={idx === rules.length - 1} onClick={() => move(r, 1)} title="下移" aria-label="下移"><ChevronDown size={14} /></button>
          </div>
          <div>
            <b>{r.name || '未命名规则'}</b>
            <small>
              {r.summary || (r.conditions || []).map(condPreview).join(' 且 ')}
              {r.lastHitAt ? ` · 最近命中 ${relativeTime(r.lastHitAt)}` : ''}
              {r.lastHitSummary ? `（${r.lastHitSummary}）` : ''}
            </small>
          </div>
          <button type="button" className={'icon-btn' + (r.enabled ? '' : ' muted')} title={r.enabled ? '停用' : '启用'} onClick={() => toggle(r)}>
            <Power size={14} />
          </button>
          <button type="button" className="icon-btn" title="编辑" onClick={() => openEdit(r)}><Pencil size={14} /></button>
          <button type="button" className="icon-btn danger" title="删除" onClick={() => remove(r)}><Trash2 size={14} /></button>
        </div>
      ))}
    </div>
  );
}
