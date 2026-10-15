import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { toLocalInput } from '../utils.js';

/** 时间选择弹层：用于稍后提醒与定时发送 */
export default function TimeMenu({ title, presets, onPick, onClose, className = '' }) {
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(toLocalInput(Date.now() + 3600_000));
  const ref = useRef();

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={'dropdown time-menu ' + className} onClick={(e) => e.stopPropagation()}>
      <div className="dropdown-title">{title}</div>
      {presets.map((p) => (
        <button key={p.label} onClick={() => onPick(p.at)}>
          <span>{p.label}</span>
          <small>{p.sub}</small>
        </button>
      ))}
      {custom ? (
        <div className="custom-time">
          <input type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(e) => setValue(e.target.value)} />
          <button className="btn-primary sm" onClick={() => { const t = new Date(value).getTime(); if (t > Date.now()) onPick(t); }}>确定</button>
        </div>
      ) : (
        <button onClick={() => setCustom(true)}>
          <span><CalendarClock size={13} /> 自定义时间…</span>
        </button>
      )}
    </div>
  );
}
