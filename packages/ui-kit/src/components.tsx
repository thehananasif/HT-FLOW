import * as RxContext from '@radix-ui/react-context-menu';
import * as RxDialog from '@radix-ui/react-dialog';
import * as RxDropdown from '@radix-ui/react-dropdown-menu';
import * as RxTooltip from '@radix-ui/react-tooltip';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'buy'
  | 'sell'
  | 'buy-outline'
  | 'sell-outline'
  | 'destructive'
  | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ht-btn',
        variant !== 'secondary' && `ht-btn--${variant}`,
        size !== 'md' && `ht-btn--${size}`,
        block && 'ht-btn--block',
        className,
      )}
      {...rest}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      data-active={active || undefined}
      className={cx('ht-icon-btn', className)}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface RibbonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  hasMenu?: boolean;
  active?: boolean;
  compact?: boolean;
}

/** Icon above label, optional chevron when the button has presets (P02). */
export const RibbonButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(function RibbonButton(
  { icon, label, hasMenu, active, compact, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ht-ribbon-btn', compact && 'ht-ribbon-btn--compact', className)}
      data-active={active || undefined}
      title={label}
      {...rest}
    >
      {icon}
      {!compact && (
        <span>
          {label}
          {hasMenu && ' ▾'}
        </span>
      )}
    </button>
  );
});

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  block,
  className,
  'aria-label': ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  block?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      className={cx('ht-seg', block && 'ht-seg--block', className)}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  selected,
  variant,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  variant?: 'ghost' | 'outlined';
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx('ht-chip', variant && `ht-chip--${variant}`, className)}
      {...rest}
    />
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ht-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { large?: boolean; invalid?: boolean }
>(function Input({ large, invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx('ht-input', large && 'ht-input--lg', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  aside,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="ht-field">
      <span className="ht-label">
        <span>{label}</span>
        {aside}
      </span>
      {children}
      {error ? (
        <span className="ht-error">{error}</span>
      ) : hint ? (
        <span className="ht-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/** Number input with ▲▼ stepper and step snapping (tick-size aware for prices). */
export function NumberInput({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  precision,
  unit,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  unit?: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const decimals = precision ?? Math.max(0, (String(step).split('.')[1] ?? '').length);
  const [text, setText] = useState(value.toFixed(decimals));
  useEffect(() => setText(value.toFixed(decimals)), [value, decimals]);
  const commit = useCallback(
    (v: number) => {
      if (!Number.isFinite(v)) {
        setText(value.toFixed(decimals));
        return;
      }
      const snapped = Math.round(v / step) * step;
      const clamped = Math.min(max, Math.max(min, snapped));
      onChange(Number(clamped.toFixed(decimals)));
    },
    [value, decimals, step, min, max, onChange],
  );
  return (
    <div className={cx('ht-num-input', className)}>
      <input
        className="tnum"
        aria-label={ariaLabel}
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(parseFloat(text))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(parseFloat(text));
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            commit(value + step);
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            commit(value - step);
          }
        }}
      />
      {unit && <span className="ht-num-unit">{unit}</span>}
      <span className="ht-stepper">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          onClick={() => commit(value + step)}
        >
          ▲
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Decrease"
          onClick={() => commit(value - step)}
        >
          ▼
        </button>
      </span>
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  small,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  small?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cx('ht-select', small && 'ht-select--sm', className)}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  radio,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  radio?: boolean;
}) {
  return (
    <label className="ht-check">
      <input
        type={radio ? 'radio' : 'checkbox'}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className="ht-toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
}) {
  return (
    <input
      type="range"
      className="ht-slider"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function ColorSwatch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className="ht-check" title={label}>
      <input
        type="color"
        aria-label={label}
        value={value.slice(0, 7)}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 22,
          height: 18,
          padding: 0,
          border: '1px solid var(--ht-border)',
          borderRadius: 4,
        }}
      />
      <span className="mono" style={{ fontSize: 11 }}>
        {value.toUpperCase()}
      </span>
    </label>
  );
}

export type BadgeKind = 'default' | 'live' | 'delayed' | 'replay' | 'error' | 'free';

export function Badge({ kind = 'default', children }: { kind?: BadgeKind; children: ReactNode }) {
  return (
    <span className={cx('ht-badge', kind !== 'default' && `ht-badge--${kind}`)}>{children}</span>
  );
}

export function StatusPill({
  state,
  label,
  onClick,
  title,
}: {
  state: string;
  label: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button type="button" className="ht-pill" onClick={onClick} title={title}>
      <span className="ht-dot" data-state={state} />
      {label}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ht-kbd">{children}</kbd>;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ht-empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ width, height }: { width: number | string; height: number | string }) {
  return <div className="ht-skeleton" style={{ width, height }} />;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RxTooltip.Root delayDuration={400}>
      <RxTooltip.Trigger asChild>{children}</RxTooltip.Trigger>
      <RxTooltip.Portal>
        <RxTooltip.Content className="ht-tooltip" sideOffset={4}>
          {content}
        </RxTooltip.Content>
      </RxTooltip.Portal>
    </RxTooltip.Root>
  );
}

export const TooltipProvider = RxTooltip.Provider;

/* ---------- Menus: one item model shared by context menus, dropdowns and the command palette ---------- */

export type MenuEntry =
  | {
      kind?: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      onSelect?: () => void;
    }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string }
  | { kind: 'submenu'; id: string; label: string; icon?: ReactNode; items: MenuEntry[] };

type MenuParts = typeof RxContext | typeof RxDropdown;

function renderEntries(P: MenuParts, entries: MenuEntry[]): ReactNode {
  return entries.map((e) => {
    if (e.kind === 'separator') return <P.Separator key={e.id} className="ht-menu-sep" />;
    if (e.kind === 'label')
      return (
        <P.Label key={e.id} className="ht-menu-label">
          {e.label}
        </P.Label>
      );
    if (e.kind === 'submenu')
      return (
        <P.Sub key={e.id}>
          <P.SubTrigger className="ht-menu-item">
            {e.icon}
            {e.label}
            <ChevronRight style={{ marginLeft: 'auto' }} />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className="ht-menu" sideOffset={2}>
              {renderEntries(P, e.items)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    return (
      <P.Item
        key={e.id}
        className="ht-menu-item"
        disabled={e.disabled}
        onSelect={() => e.onSelect?.()}
      >
        {e.icon ??
          (e.checked !== undefined ? (
            <span style={{ width: 14 }}>{e.checked ? '✓' : ''}</span>
          ) : null)}
        {e.label}
        {e.shortcut && <span className="ht-menu-sc">{e.shortcut}</span>}
      </P.Item>
    );
  });
}

export function ContextMenu({ items, children }: { items: MenuEntry[]; children: ReactNode }) {
  return (
    <RxContext.Root>
      <RxContext.Trigger asChild>{children}</RxContext.Trigger>
      <RxContext.Portal>
        <RxContext.Content className="ht-menu">{renderEntries(RxContext, items)}</RxContext.Content>
      </RxContext.Portal>
    </RxContext.Root>
  );
}

export function DropdownMenu({
  items,
  trigger,
  align = 'start',
}: {
  items: MenuEntry[];
  trigger: ReactNode;
  align?: 'start' | 'end' | 'center';
}) {
  return (
    <RxDropdown.Root>
      <RxDropdown.Trigger asChild>{trigger}</RxDropdown.Trigger>
      <RxDropdown.Portal>
        <RxDropdown.Content className="ht-menu" align={align} sideOffset={4}>
          {renderEntries(RxDropdown, items)}
        </RxDropdown.Content>
      </RxDropdown.Portal>
    </RxDropdown.Root>
  );
}

/** Small "label ▾" trigger used in window headers. */
export const MenuTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function MenuTrigger({ children, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={cx('ht-chip ht-chip--ghost', className)} {...rest}>
        {children}
        <ChevronDown size={12} />
      </button>
    );
  },
);

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <RxDialog.Root open={open} onOpenChange={onOpenChange}>
      <RxDialog.Portal>
        <RxDialog.Overlay className="ht-scrim" />
        <RxDialog.Content className="ht-dialog" style={width ? { width } : undefined}>
          <RxDialog.Title className="ht-dialog-title">{title}</RxDialog.Title>
          {description ? (
            <RxDialog.Description className="ht-dialog-desc">{description}</RxDialog.Description>
          ) : (
            <RxDialog.Description className="ht-dialog-desc" style={{ display: 'none' }}>
              {title}
            </RxDialog.Description>
          )}
          {children}
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
  );
}

/* ---------- Toasts ---------- */

export interface ToastMsg {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warning';
  title: string;
  body?: string;
}

const toastListeners = new Set<(t: ToastMsg[]) => void>();
let toasts: ToastMsg[] = [];
let toastId = 1;

export function toast(kind: ToastMsg['kind'], title: string, body?: string, ms = 4000): void {
  const t: ToastMsg = { id: toastId++, kind, title, body };
  toasts = [...toasts, t].slice(-5);
  toastListeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l(toasts));
  }, ms);
}

export function Toaster() {
  const [list, setList] = useState<ToastMsg[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return (
    <div className="ht-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="ht-toast" data-kind={t.kind}>
          <div>
            <strong>{t.title}</strong>
            {t.body}
          </div>
        </div>
      ))}
    </div>
  );
}
