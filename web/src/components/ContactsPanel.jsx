import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2, Plus, Pencil, Trash2, Search, Crown, BellOff, Merge, Mail, Sparkles, X, Check,
} from 'lucide-react';
import { api } from '../api.js';
import { avatarColor, initials, relativeTime } from '../utils.js';

const DEFAULT_COLORS = ['#0a66ff', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#475569', '#0891b2'];

function PersonEditor({ person, tagsCatalog, colors, notify, onSaved, onDeleted, onClose }) {
  const [displayName, setDisplayName] = useState(person?.displayName || '');
  const [company, setCompany] = useState(person?.company || '');
  const [note, setNote] = useState(person?.note || '');
  const [addrInput, setAddrInput] = useState('');
  const [busy, setBusy] = useState('');
  const [mergeId, setMergeId] = useState('');
  const [others, setOthers] = useState([]);
  const [local, setLocal] = useState(person);

  useEffect(() => {
    setLocal(person);
    setDisplayName(person?.displayName || '');
    setCompany(person?.company || '');
    setNote(person?.note || '');
  }, [person]);

  useEffect(() => {
    if (!person?.id) return;
    api('/contact-persons?limit=100')
      .then((d) => setOthers((d.persons || []).filter((p) => p.id !== person.id)))
      .catch(() => {});
  }, [person?.id]);

  async function saveMeta() {
    setBusy('save');
    try {
      const d = await api(`/contact-persons/${local.id}`, {
        method: 'PATCH',
        body: { displayName, company, note },
      });
      setLocal(d.person);
      notify('已保存');
      onSaved?.(d.person);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function addAddr(e) {
    e?.preventDefault();
    if (!addrInput.trim()) return;
    setBusy('addr');
    try {
      const d = await api(`/contact-persons/${local.id}/addresses`, {
        method: 'POST',
        body: { address: addrInput.trim() },
      });
      setLocal(d.person);
      setAddrInput('');
      notify('已添加邮箱');
      onSaved?.(d.person);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function removeAddr(address) {
    if (!window.confirm(`移除邮箱 ${address}？`)) return;
    try {
      const d = await api(`/contact-persons/${local.id}/addresses/${encodeURIComponent(address)}`, { method: 'DELETE' });
      setLocal(d.person);
      notify('已移除');
      onSaved?.(d.person);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function setPrimary(address) {
    try {
      const d = await api(`/contact-persons/${local.id}/primary`, { method: 'POST', body: { address } });
      setLocal(d.person);
      onSaved?.(d.person);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function toggleTag(tagId, on) {
    try {
      const d = await api(`/contact-persons/${local.id}/tags`, {
        method: 'POST',
        body: on ? { remove: [tagId] } : { add: [tagId] },
      });
      setLocal(d.person);
      onSaved?.(d.person);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function doMerge() {
    const toId = Number(mergeId);
    if (!toId) return;
    if (!window.confirm('合并后所有邮箱将归到同一客户，不可自动拆回。继续？')) return;
    setBusy('merge');
    try {
      const d = await api('/contact-persons/merge', { method: 'POST', body: { fromId: local.id, toId } });
      notify('已合并');
      onDeleted?.(local.id);
      onSaved?.(d.person);
      onClose?.();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (!window.confirm(`删除联系人「${local.displayName || local.primaryAddress}」？\n邮件历史不会删除。`)) return;
    try {
      await api(`/contact-persons/${local.id}`, { method: 'DELETE' });
      notify('已删除联系人');
      onDeleted?.(local.id);
      onClose?.();
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  const tagIds = new Set((local?.tags || []).map((t) => t.id));

  return (
    <div className="contact-detail">
      <div className="contact-detail-head">
        <span className="avatar lg" style={{ background: avatarColor(local.primaryAddress) }}>
          {initials({ name: local.displayName || local.company, address: local.primaryAddress })}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{local.displayName || local.primaryAddress}</b>
          <small>{local.company || local.primaryAddress}</small>
        </div>
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>}
      </div>

      <label className="contact-field">
        <span>显示名</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
      </label>
      <label className="contact-field">
        <span>公司</span>
        <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} placeholder="公司名称" />
      </label>
      <label className="contact-field">
        <span>备注</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} placeholder="付款习惯、旺季、对接人…" />
      </label>
      <button type="button" className="btn-primary sm" disabled={busy === 'save'} onClick={saveMeta}>
        {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} 保存资料
      </button>

      <div className="customer-section-title" style={{ marginTop: 12 }}>邮箱地址</div>
      <ul className="contact-addr-list">
        {(local.addresses || []).map((a) => (
          <li key={a.address}>
            <Mail size={12} />
            <span className="addr">{a.address}</span>
            {a.isPrimary ? <em className="pill">主要</em> : (
              <button type="button" className="btn-ghost xs" onClick={() => setPrimary(a.address)}>设为主要</button>
            )}
            <button type="button" className="icon-btn danger" title="移除" onClick={() => removeAddr(a.address)}><Trash2 size={12} /></button>
          </li>
        ))}
      </ul>
      <form className="glossary-add" onSubmit={addAddr}>
        <input value={addrInput} onChange={(e) => setAddrInput(e.target.value)} placeholder="添加邮箱地址" />
        <button type="submit" className="btn-ghost sm" disabled={busy === 'addr' || !addrInput.trim()}>添加</button>
      </form>

      <div className="customer-section-title" style={{ marginTop: 12 }}>客户标签</div>
      <div className="contact-tag-picks">
        {(tagsCatalog || []).map((t) => (
          <button
            key={t.id}
            type="button"
            className={'chip-tag' + (tagIds.has(t.id) ? ' on' : '')}
            style={{ '--tag-c': t.color }}
            onClick={() => toggleTag(t.id, tagIds.has(t.id))}
          >
            <span className="label-dot" style={{ background: t.color }} />
            {t.name}
          </button>
        ))}
        {!tagsCatalog?.length && <small className="muted">请先在下方创建客户标签</small>}
      </div>

      {local.rule?.kind === 'vip' && (
        <div className="vip-suggest" style={{ marginTop: 8 }}><Crown size={12} /> 已是 VIP（按发件人规则）</div>
      )}
      {local.rule?.kind === 'muted' && (
        <div className="vip-suggest" style={{ marginTop: 8 }}><BellOff size={12} /> 已静音</div>
      )}

      <div className="customer-section-title" style={{ marginTop: 12 }}>合并到…</div>
      <div className="contact-merge-row">
        <select value={mergeId} onChange={(e) => setMergeId(e.target.value)}>
          <option value="">选择目标联系人</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>{p.displayName || p.primaryAddress}{p.company ? ` · ${p.company}` : ''}</option>
          ))}
        </select>
        <button type="button" className="btn-ghost sm" disabled={!mergeId || busy === 'merge'} onClick={doMerge}>
          <Merge size={14} /> 合并
        </button>
      </div>
      <small className="muted">合并后所有邮箱将归到同一客户，不可自动拆回</small>

      <button type="button" className="btn-ghost sm danger" style={{ marginTop: 16 }} onClick={remove}>
        <Trash2 size={14} /> 删除联系人
      </button>
    </div>
  );
}

export default function ContactsPanel({ notify }) {
  const [list, setList] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [tags, setTags] = useState([]);
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [tagName, setTagName] = useState('');
  const [tagColor, setTagColor] = useState(DEFAULT_COLORS[0]);

  async function load(query = q) {
    try {
      const d = await api('/contact-persons?limit=80&q=' + encodeURIComponent(query || ''));
      setList(d.persons || []);
      setTotal(d.total || 0);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function loadTags() {
    try {
      const d = await api('/contact-tags');
      setTags(d.tags || []);
      if (d.colors?.length) setColors(d.colors);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  useEffect(() => { load(); loadTags(); }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), 220);
    return () => clearTimeout(t);
  }, [q]);

  async function create(e) {
    e.preventDefault();
    if (!newAddr.trim()) return;
    setBusy('create');
    try {
      const d = await api('/contact-persons', {
        method: 'POST',
        body: { displayName: newName.trim(), company: newCompany.trim(), address: newAddr.trim() },
      });
      setCreating(false);
      setNewName('');
      setNewCompany('');
      setNewAddr('');
      notify('联系人已创建');
      await load();
      setSelected(d.person);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function createTag(e) {
    e.preventDefault();
    if (!tagName.trim()) return;
    try {
      const d = await api('/contact-tags', { method: 'POST', body: { name: tagName.trim(), color: tagColor } });
      setTags(d.tags);
      setTagName('');
      notify('客户标签已创建');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function presets() {
    setBusy('presets');
    try {
      const d = await api('/contact-tags/presets', { method: 'POST', body: {} });
      setTags(d.tags);
      const n = d.created?.length || 0;
      notify(n ? `已添加 ${n} 个推荐客户标签` : '推荐标签已存在');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const detail = useMemo(() => {
    if (!selected) return null;
    return list?.find((p) => p.id === selected.id) || selected;
  }, [selected, list]);

  return (
    <>
      <div className="set-row">
        <div>
          <b>联系人</b>
          <small>客户主数据：多邮箱、公司、备注与客户标签。往来会自动积累。</small>
        </div>
        <button type="button" className="btn-primary sm" onClick={() => setCreating((v) => !v)}>
          <Plus size={14} /> 新建
        </button>
      </div>

      {creating && (
        <form className="contact-create-form" onSubmit={create}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="显示名（可选）" maxLength={80} />
          <input value={newCompany} onChange={(e) => setNewCompany(e.target.value)} placeholder="公司（可选）" maxLength={120} />
          <input value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder="邮箱地址（必填）" required />
          <button type="submit" className="btn-primary sm" disabled={busy === 'create' || !newAddr.trim()}>创建</button>
          <button type="button" className="btn-ghost sm" onClick={() => setCreating(false)}>取消</button>
        </form>
      )}

      <div className="contact-search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名 / 公司 / 地址" />
      </div>

      <div className="contact-layout">
        <div className="contact-list-pane">
          {!list && <div className="muted">加载中…</div>}
          {list && !list.length && (
            <div className="empty-inline">联系人会随往来自动积累，也可手动新建</div>
          )}
          {list?.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'contact-row' + (detail?.id === p.id ? ' active' : '')}
              onClick={() => setSelected(p)}
            >
              <span className="avatar sm" style={{ background: avatarColor(p.primaryAddress) }}>
                {initials({ name: p.displayName || p.company, address: p.primaryAddress })}
              </span>
              <div className="contact-row-main">
                <b>{p.displayName || p.primaryAddress}</b>
                <small>
                  {p.company ? `${p.company} · ` : ''}
                  {(p.addresses || []).map((a) => a.address).join(' · ')}
                </small>
              </div>
              <div className="contact-row-meta">
                {p.rule?.kind === 'vip' && <Crown size={12} className="vip-ico" />}
                {(p.tags || []).slice(0, 2).map((t) => (
                  <span key={t.id} className="chip-tag xs" style={{ '--tag-c': t.color }}>{t.name}</span>
                ))}
                {p.lastAt && <small>{relativeTime(p.lastAt)}</small>}
              </div>
            </button>
          ))}
          {list && total > list.length && <small className="muted">共 {total} 人，仅显示前 {list.length} 条</small>}
        </div>
        <div className="contact-detail-pane">
          {detail ? (
            <PersonEditor
              person={detail}
              tagsCatalog={tags}
              colors={colors}
              notify={notify}
              onSaved={(p) => {
                setSelected(p);
                load();
              }}
              onDeleted={() => { setSelected(null); load(); }}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div className="empty-inline">选择左侧联系人查看详情，或新建</div>
          )}
        </div>
      </div>

      <div className="set-row" style={{ marginTop: 20 }}>
        <div>
          <b>客户标签</b>
          <small>贴在人身上（如 EU买家、ODM），与邮件标签分开。</small>
        </div>
        <button type="button" className="btn-ghost sm" disabled={busy === 'presets'} onClick={presets}>
          {busy === 'presets' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 添加外贸推荐
        </button>
      </div>
      <form className="glossary-add label-create-form" onSubmit={createTag}>
        <span className="label-dot lg" style={{ background: tagColor }} />
        <input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="新客户标签" maxLength={40} />
        <div className="label-color-picks" role="group" aria-label="颜色">
          {colors.map((c) => (
            <button key={c} type="button" className={'label-color-swatch' + (tagColor === c ? ' on' : '')} style={{ background: c }} aria-label={c} onClick={() => setTagColor(c)} />
          ))}
        </div>
        <button type="submit" className="btn-primary sm" disabled={!tagName.trim()}>创建</button>
      </form>
      <div className="contact-tag-catalog">
        {tags.map((t) => (
          <span key={t.id} className="chip-tag" style={{ '--tag-c': t.color }}>
            <span className="label-dot" style={{ background: t.color }} />
            {t.name}
            <small>{t.count || 0}</small>
            <button
              type="button"
              className="icon-btn xs"
              title="删除"
              onClick={async () => {
                if (!window.confirm(`删除客户标签「${t.name}」？`)) return;
                try {
                  const d = await api(`/contact-tags/${t.id}`, { method: 'DELETE' });
                  setTags(d.tags);
                  notify('已删除');
                  load();
                } catch (e) {
                  notify(e.message, 'error');
                }
              }}
            >
              <Trash2 size={11} />
            </button>
          </span>
        ))}
      </div>
    </>
  );
}
