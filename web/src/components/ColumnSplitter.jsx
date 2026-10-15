import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 可拖拽分栏分隔条。hit 区 ≥6px，cursor col-resize。
 * onDrag(deltaX) 在拖动中连续回调；onDragEnd 在松开时回调。
 * 双击恢复默认。默认可见淡握点，提升可发现性。
 */
export default function ColumnSplitter({
  style,
  onDrag,
  onDragEnd,
  disabled = false,
  label = '拖拽调整 · 双击恢复默认',
}) {
  const [active, setActive] = useState(false);
  const startX = useRef(0);
  const dragging = useRef(false);

  const end = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    document.body.classList.remove('col-resizing');
    onDragEnd?.();
  }, [onDragEnd]);

  useEffect(() => {
    if (!active) return undefined;
    const onMove = (e) => {
      if (!dragging.current) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      if (x == null) return;
      onDrag?.(x - startX.current);
      startX.current = x;
    };
    const onUp = () => end();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [active, end, onDrag]);

  if (disabled) return null;

  return (
    <div
      className={'col-splitter' + (active ? ' active' : '')}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        startX.current = e.clientX;
        setActive(true);
        document.body.classList.add('col-resizing');
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onDblClick={(e) => {
        e.preventDefault();
        onDrag?.('reset');
        onDragEnd?.();
      }}
    >
      <span className="col-splitter-grip" aria-hidden>
        <i /><i /><i />
      </span>
    </div>
  );
}
