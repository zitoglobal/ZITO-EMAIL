import React, { useMemo, useState } from 'react';
import { Check, Plus, Tag } from 'lucide-react';

/** 贴标下拉：多选勾选；可快速新建 */
export default function LabelMenu({
  labels = [],
  selectedIds = [],
  onToggle,
  onCreate,
  onClose,
  className = '',
  title = '邮件标签',
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sel = useMemo(() => new Set(selectedIds), [selectedIds]);

  async function create(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n || !onCreate) return;
    setBusy(true);
    try {
      await onCreate(n);
      setName('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={'dropdown label-menu ' + className} role="menu" onMouseLeave={onClose}>
      <div className="dropdown-title"><Tag size={12} /> {title}</div>
      {!labels.length && <div className="label-menu-empty">用标签整理询盘、样品、大货，不影响文件夹</div>}
      <div className="label-menu-list">
        {labels.map((l) => {
          const on = sel.has(l.id);
          return (
            <button
              type="button"
              key={l.id}
              role="menuitemcheckbox"
              aria-checked={on}
              className={on ? 'on' : ''}
              onClick={() => onToggle?.(l, !on)}
            >
              <span className="label-dot" style={{ background: l.color }} />
              <span className="folder-name">{l.name}</span>
              {on && <Check size={14} />}
            </button>
          );
        })}
      </div>
      {onCreate && (
        <form className="label-menu-create" onSubmit={create}>
          <Plus size={14} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新建标签"
            maxLength={40}
            disabled={busy}
          />
          <button type="submit" className="text" disabled={busy || !name.trim()}>添加</button>
        </form>
      )}
    </div>
  );
}
