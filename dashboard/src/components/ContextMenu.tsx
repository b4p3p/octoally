import { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  kind?: 'item' | 'separator';
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // Adjust position if menu would overflow viewport
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let nx = x;
      let ny = y;
      if (x + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
      if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
      if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
    }
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] rounded-md shadow-lg py-1 text-xs"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        minWidth: 200,
        color: 'var(--text-primary)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={i} className="my-1" style={{ borderTop: '1px solid var(--border)' }} />;
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled && item.onClick) { item.onClick(); onClose(); } }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ color: item.danger ? 'var(--error)' : 'var(--text-primary)' }}
          >
            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
