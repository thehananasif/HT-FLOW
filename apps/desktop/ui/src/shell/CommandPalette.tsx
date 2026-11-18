import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Kbd } from '@htflow/ui-kit';
import { commands, onCommandsChange, paletteItems, type Command } from './commands';
import { rowKey, searchPalette, type PaletteRow } from './paletteSearch';

import { translateLiteral as tl } from '@htflow/i18n';
/** Ctrl+K — searches commands, indicators, settings, instruments, layouts and modules. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => onCommandsChange(() => force((x) => x + 1)), []);
  // Focus in the same commit that shows the palette: a deferred focus (setTimeout) let the first
  // keystrokes typed right after Ctrl+K reach the window underneath (and its hotkeys) on a busy PC.
  useLayoutEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open]);
  const list = useMemo<PaletteRow[]>(
    () => searchPalette(q, commands(), paletteItems()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, open],
  );
  // Keyboard navigation keeps the active option visible.
  useEffect(() => {
    if (open) document.getElementById(`palette-opt-${sel}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, sel]);
  if (!open) return null;
  const run = (row: PaletteRow | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === 'command') row.command.run();
    else row.item.run();
  };
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={tl('Command palette')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={tl('Search commands, symbols, layouts…')}
          role="combobox"
          aria-label={tl('Search commands, symbols, layouts')}
          aria-expanded={list.length > 0}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={list.length ? `palette-opt-${sel}` : undefined}
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
        <div
          className="palette-list"
          id="palette-list"
          role="listbox"
          aria-label={tl('Results')}
          tabIndex={-1}
        >
          {list.map((row, i) => {
            // Headers separate the item groups; they are not selectable, so `sel` indexes `list`.
            const prev = list[i - 1];
            const header =
              row.kind === 'item' && (prev?.kind !== 'item' || prev.item.group !== row.item.group)
                ? tl(row.item.group)
                : null;
            const key = rowKey(row);
            return (
              <Fragment key={key}>
                {header && (
                  <div className="palette-header" role="presentation">
                    {header}
                  </div>
                )}
                <div
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  className="palette-item"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(row)}
                >
                  {row.kind === 'command' ? (
                    <CommandRow command={row.command} />
                  ) : (
                    <>
                      <span className="palette-label">{tl(row.item.label)}</span>
                      {row.item.hint && <span className="palette-hint">{tl(row.item.hint)}</span>}
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
          {!list.length && <div className="palette-empty">{tl('No matches')}</div>}
        </div>
      </div>
    </div>
  );
}

function CommandRow({ command: c }: { command: Command }) {
  return (
    <>
      <span className="palette-group">{tl(c.group)}</span>
      <span className="palette-label">{tl(c.label)}</span>
      {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
    </>
  );
}
