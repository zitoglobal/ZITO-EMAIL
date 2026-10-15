import React, { useEffect, useState } from 'react';
import { Bookmark, X } from 'lucide-react';

/**
 * 保存 / 编辑智能文件夹
 * mode: 'create' | 'edit'
 */
export default function SaveSearchModal({
  open,
  mode = 'create',
  initialName = '',
  initialQuery = '',
  presets = [],
  onClose,
  onSubmit,
}) {
  const [name, setName] = useState(initialName);
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initialName || '');
    setQuery(initialQuery || '');
    setErr('');
    setBusy(false);
  }, [open, initialName, initialQuery]);

  if (!open) return null;

  async function submit(e) {
    e?.preventDefault();
    const n = name.trim();
    const q = query.trim();
    if (!n) return setErr('请输入名称');
    if (!q) return setErr('查询不能为空');
    setBusy(true);
    setErr('');
    try {
      await onSubmit({ name: n, query: q });
    } catch (ex) {
      setErr(ex.message || '保存失败');
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal save-search-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mode === 'edit' ? '编辑智能文件夹' : '保存为智能文件夹'}>
        <div className="modal-head">
          <b><Bookmark size={16} /> {mode === 'edit' ? '编辑智能文件夹' : '保存为智能文件夹'}</b>
          <div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <label className="field">
              <span>名称</span>
              <input
                autoFocus
                value={name}
                maxLength={40}
                placeholder="例如：本周报价"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field" style={{ marginTop: 12 }}>
              <span>查询</span>
              <input
                value={query}
                maxLength={500}
                placeholder="from:acme has:attachment"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <p className="set-desc" style={{ marginTop: 8, marginBottom: 0 }}>
              支持 <code>from:</code> <code>to:</code> <code>subject:</code> <code>has:attachment</code>{' '}
              <code>is:unread</code> <code>is:vip</code> <code>label:</code> <code>category:</code>
            </p>
            {mode === 'create' && presets?.length > 0 && (
              <div className="save-search-presets">
                <span className="muted-text" style={{ fontSize: 12 }}>推荐模板</span>
                <div className="chips" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {presets.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className="chip"
                      onClick={() => {
                        setName(p.name);
                        setQuery(p.query);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {err && <div className="form-error" style={{ marginTop: 12 }}>{err}</div>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? '保存中…' : mode === 'edit' ? '更新' : '保存到侧栏'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
