import { useEffect, useMemo, useRef, useState } from 'react';
import { Kbd } from '@htflow/ui-kit';
import { commands, onCommandsChange, type Command } from './commands';

/** Ctrl+K — searches commands, instruments, layouts and modules. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => onCommandsChange(() => force((x) => x + 1)), []);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  const list = useMemo(() => {
    const all = commands();
    if (!q.trim()) return all.slice(0, 60);
    const terms = q.toLowerCase().split(/\s+/);
    return all
      .map((c) => {
        const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          const i = hay.indexOf(t);
          if (i < 0) return null;
          score += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
        }
        return { c, score };
      })
      .filter((x): x is { c: Command; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search commands, symbols, layouts…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(list.length - 1, s + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            if (e.key === 'Enter') run(list[sel]);
          }}
        />
        <div className="palette-list" role="listbox">
          {list.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === sel}
              className="palette-item"
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
            </div>
          ))}
          {!list.length && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
