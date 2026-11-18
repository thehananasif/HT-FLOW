import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { translateLiteral as tl } from '@htflow/i18n';
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export interface ComboOption {
  value: string;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}

/** Case-insensitive substring filter that ranks prefix matches first. */
export function filterOptions(options: ComboOption[], query: string): ComboOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const starts: ComboOption[] = [];
  const contains: ComboOption[] = [];
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (l.startsWith(q)) starts.push(o);
    else if (l.includes(q) || o.value.toLowerCase().includes(q)) contains.push(o);
  }
  return [...starts, ...contains];
}

export interface ComboboxProps {
  value: string | null;
  onChange: (value: string, option: ComboOption | null) => void;
  /** Static options (filtered locally). */
  options?: ComboOption[];
  /** Async options: called (debounced) with the query; takes over from `options`. */
  loadOptions?: (query: string) => Promise<ComboOption[]>;
  /** Label to show for `value` when it is not in the loaded list (async mode). */
  valueLabel?: string;
  placeholder?: string;
  /** Accept free text on Enter (value = typed text). */
  allowCustom?: boolean;
  debounceMs?: number;
  disabled?: boolean;
  className?: string;
  'aria-label': string;
}

/** Searchable select with keyboard navigation (WAI-ARIA combobox / listbox) and async options. */
export function Combobox({
  value,
  onChange,
  options = [],
  loadOptions,
  valueLabel,
  placeholder = 'Search…',
  allowCustom,
  debounceMs = 150,
  disabled,
  className,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<ComboOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const known = useRef(new Map<string, ComboOption>());

  const list = loadOptions ? remote : filterOptions(options, typing ? query : '');
  list.forEach((o) => known.current.set(o.value, o));
  options.forEach((o) => known.current.set(o.value, o));
  const selected = value == null ? undefined : known.current.get(value);
  const shownLabel = selected?.label ?? valueLabel ?? value ?? '';

  useEffect(() => {
    if (!open || !loadOptions) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      loadOptions(typing ? query : '')
        .then((r) => {
          if (my !== seq.current) return;
          setRemote(r);
          setError(false);
          setLoading(false);
        })
        .catch(() => {
          if (my !== seq.current) return;
          setError(true);
          setLoading(false);
        });
    }, debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, typing]);

  useEffect(() => {
    setActive(0);
  }, [query, remote, open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  });

  const close = () => {
    setOpen(false);
    setTyping(false);
    setQuery('');
  };
  const pick = (o: ComboOption) => {
    if (o.disabled) return;
    known.current.set(o.value, o);
    onChange(o.value, o);
    close();
  };
  const optId = (i: number) => `${uid}-opt-${i}`;

  return (
    <div ref={root} className={cx('ht-combo', className)}>
      <input
        ref={input}
        className="ht-input ht-combo-input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && list[active] ? optId(active) : undefined}
        disabled={disabled}
        placeholder={tl(placeholder)}
        value={typing ? query : open ? '' : shownLabel}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setTyping(true);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Home' && open) {
            e.preventDefault();
            setActive(0);
          } else if (e.key === 'End' && open) {
            e.preventDefault();
            setActive(Math.max(0, list.length - 1));
          } else if (e.key === 'Enter') {
            if (open && list[active]) {
              e.preventDefault();
              pick(list[active]!);
            } else if (open && allowCustom && query.trim()) {
              e.preventDefault();
              onChange(query.trim(), null);
              close();
            }
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close();
          } else if (e.key === 'Tab') {
            close();
          }
        }}
      />
      <ChevronDown className="ht-combo-chev" size={12} aria-hidden />
      {open && (
        <ul id={`${uid}-list`} role="listbox" aria-label={ariaLabel} className="ht-combo-list">
          {list.map((o, i) => (
            <li
              key={o.value}
              id={optId(i)}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-active={i === active || undefined}
              className="ht-combo-opt"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onPointerMove={() => setActive(i)}
            >
              <span>{o.label}</span>
              {o.hint != null && <span className="ht-combo-hint">{o.hint}</span>}
            </li>
          ))}
          {list.length === 0 && (
            <li className="ht-combo-empty" role="presentation">
              {loading ? 'Loading…' : error ? 'Could not load options' : 'No matches'}
            </li>
          )}
          {list.length > 0 && loading && (
            <li className="ht-combo-empty" role="presentation">
              {tl('Loading…')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
