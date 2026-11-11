/** Custom editors of the Settings window (tokens, hot keys, sounds, commission rules, clocks). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, RotateCcw, Trash2, Plus, Circle } from 'lucide-react';
import { Badge, Button, THEMES, toast, type ThemeName, type ThemeTokens } from '@htflow/ui-kit';
import {
  HOTKEY_SCOPES,
  defaultShortcut,
  eventToShortcut,
  hotkeyConflicts,
  isModifierOnly,
  onCommandsChange,
  registeredCommands,
  setHotkeysSuspended,
  type Command,
  type HotkeyOverrides,
  type HotkeyScope,
} from '../../shell/commands';
import {
  normalizeHex,
  type CommissionRule,
  type SettingsValues,
  type TokenOverrides,
} from '../../state/settings';
import {
  BUILTIN_SOUNDS,
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUNDS,
  SOUND_EVENTS,
  playSoundRef,
  type CustomSound,
  type SoundEvent,
  type SoundEventConfig,
} from '../../sound';
import { paper } from '../../state/market';
import { allInstruments } from '../../state/instruments';
import { isTauri } from '../../backend';
import { EXCHANGES, exchangeStatus, formatDuration, resolveCommission } from './model';

export interface EditorProps<T> {
  value: T;
  onChange(v: T): void;
  draft: SettingsValues;
}

// ------------------------------------------------------------------ tokens

export const TOKEN_GROUPS: { label: string; keys: (keyof ThemeTokens)[] }[] = [
  {
    label: 'Surfaces',
    keys: [
      'bg',
      'surface1',
      'surface2',
      'surface3',
      'surfaceSheet',
      'border',
      'divider',
      'hover',
      'pressed',
      'muted',
      'accent',
      'accentText',
    ],
  },
  {
    label: 'Text',
    keys: ['textPrimary', 'textSecondary', 'textTertiary', 'textDisabled', 'textSoft'],
  },
  { label: 'Market colours', keys: ['up', 'down', 'warning', 'info', 'special', 'downSoft'] },
  { label: 'Chart', keys: ['chartBg', 'grid', 'volume', 'cluster', 'clusterStrong'] },
];

function TokenRow({
  k,
  base,
  value,
  onSet,
}: {
  k: keyof ThemeTokens;
  base: string;
  value: string;
  onSet(v: string | undefined): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const modified = value.toUpperCase() !== base.toUpperCase();
  return (
    <div
      className="st-token"
      title={`--ht-${k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase())}`}
    >
      <span className="st-dot-slot">{modified && <span className="st-mod" />}</span>
      <input
        type="color"
        aria-label={`${k} colour`}
        value={value.slice(0, 7).toLowerCase()}
        onChange={(e) => onSet(e.target.value)}
      />
      <span className="st-token-name">{k}</span>
      <input
        className="st-hex mono"
        aria-label={`${k} hex`}
        value={text}
        aria-invalid={!normalizeHex(text) || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const h = normalizeHex(e.target.value);
          if (h) onSet(h);
        }}
      />
      {modified && (
        <button className="ht-icon-btn" aria-label={`Reset ${k}`} onClick={() => onSet(undefined)}>
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  );
}

export function TokensEditor({ value, onChange, draft }: EditorProps<TokenOverrides>) {
  const base = THEMES[draft['appearance.theme'] as ThemeName];
  const set = (k: keyof ThemeTokens, v: string | undefined) => {
    const next = { ...value };
    if (!v || v.toUpperCase() === base[k].toUpperCase()) delete next[k];
    else next[k] = v.toUpperCase();
    onChange(next);
  };
  return (
    <div className="st-tokens">
      {TOKEN_GROUPS.map((g) => (
        <div key={g.label} className="st-token-group">
          <div className="st-subhead">{g.label}</div>
          {g.keys.map((k) => (
            <TokenRow
              key={k}
              k={k}
              base={base[k]}
              value={value[k] ?? base[k]}
              onSet={(v) => set(k, v)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Small preview card drawn with the draft tokens. */
export function ThemePreview({ draft }: { draft: SettingsValues }) {
  const t = { ...THEMES[draft['appearance.theme'] as ThemeName], ...draft['appearance.tokens'] };
  const candles: [number, number, number, number][] = [
    [40, 20, 46, 14],
    [30, 22, 36, 18],
    [26, 34, 38, 24],
    [34, 44, 48, 30],
    [44, 38, 50, 34],
    [38, 50, 56, 36],
    [50, 46, 58, 42],
    [46, 56, 62, 44],
  ];
  return (
    <div
      className="st-preview"
      style={{ background: t.surface1, borderColor: t.border, color: t.textPrimary }}
    >
      <div className="row between center-y" style={{ background: t.surface2, padding: '6px 8px' }}>
        <b>ESZ6</b>
        <span style={{ color: t.textSecondary }}>5m · Footprint</span>
      </div>
      <svg
        viewBox="0 0 160 70"
        width="100%"
        height="90"
        style={{ background: t.chartBg, display: 'block' }}
      >
        {[15, 35, 55].map((y) => (
          <line key={y} x1={0} x2={160} y1={y} y2={y} stroke={t.grid} strokeDasharray="2 2" />
        ))}
        {candles.map(([o, c, h, l], i) => {
          const up = c > o;
          const x = 10 + i * 18;
          const col = up ? t.up : t.down;
          return (
            <g key={i}>
              <line x1={x + 5} x2={x + 5} y1={70 - h} y2={70 - l} stroke={col} />
              <rect
                x={x}
                y={70 - Math.max(o, c)}
                width={10}
                height={Math.max(1, Math.abs(c - o))}
                fill={col}
              />
              <rect x={x} y={64} width={10} height={6} fill={t.volume} opacity={0.6} />
            </g>
          );
        })}
      </svg>
      <div className="row gap6" style={{ padding: 8 }}>
        <span className="st-pv-btn" style={{ background: t.up, color: '#000' }}>
          Buy
        </span>
        <span className="st-pv-btn" style={{ background: t.down, color: '#fff' }}>
          Sell
        </span>
        <span className="st-pv-btn" style={{ background: t.accent, color: t.accentText }}>
          Primary
        </span>
        <span className="st-pv-btn" style={{ background: t.surface3, color: t.textSoft }}>
          Secondary
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ hot keys

function useCommandList(): Command[] {
  const [, force] = useState(0);
  useEffect(() => onCommandsChange(() => force((x) => x + 1)), []);
  return registeredCommands();
}

function Recorder({
  value,
  onRecord,
  label,
}: {
  value?: string;
  onRecord(v: string | null): void;
  label: string;
}) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    setHotkeysSuspended(rec);
    return () => setHotkeysSuspended(false);
  }, [rec]);
  return (
    <button
      type="button"
      className="st-rec"
      data-recording={rec || undefined}
      aria-label={`Shortcut for ${label}`}
      title="Click, then press the new key combination (Esc cancels, Backspace clears)"
      onClick={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return;
        e.preventDefault();
        e.stopPropagation();
        const ne = e.nativeEvent;
        if (isModifierOnly(ne)) return;
        if (e.key === 'Escape') return setRec(false);
        if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          onRecord(null);
          return setRec(false);
        }
        onRecord(eventToShortcut(ne));
        setRec(false);
      }}
    >
      {rec ? (
        'Press keys…'
      ) : value ? (
        <kbd className="ht-kbd">{value}</kbd>
      ) : (
        <span className="muted">—</span>
      )}
    </button>
  );
}

export function HotkeysEditor({
  value,
  onChange,
  filter,
}: EditorProps<HotkeyOverrides> & { filter: string }) {
  const cmds = useCommandList();
  const rows = useMemo(
    () =>
      cmds.map((c) => {
        const o = value[c.id];
        const shortcut =
          o && o.shortcut !== undefined ? (o.shortcut ?? undefined) : defaultShortcut(c.id);
        return {
          c,
          shortcut,
          scope: (o?.scope ?? c.scope ?? 'global') as HotkeyScope,
          modified: !!o,
        };
      }),
    [cmds, value],
  );
  const conflicts = useMemo(
    () => hotkeyConflicts(rows.map((r) => ({ id: r.c.id, shortcut: r.shortcut, scope: r.scope }))),
    [rows],
  );
  const q = filter.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      !q || `${r.c.label} ${r.c.group} ${r.shortcut ?? ''} ${r.c.id}`.toLowerCase().includes(q),
  );
  const groups = [...new Set(shown.map((r) => r.c.group))];
  const label = (id: string) => cmds.find((c) => c.id === id)?.label ?? id;
  const set = (id: string, patch: { shortcut?: string | null; scope?: HotkeyScope }) => {
    const cmd = cmds.find((c) => c.id === id);
    const next = { ...value, [id]: { ...value[id], ...patch } };
    const b = next[id]!;
    if (b.shortcut !== undefined && b.shortcut === (defaultShortcut(id) ?? null)) delete b.shortcut;
    if (b.scope && b.scope === (cmd?.scope ?? 'global')) delete b.scope;
    if (b.shortcut === undefined && !b.scope) delete next[id];
    onChange(next);
  };
  return (
    <div className="st-hotkeys">
      {conflicts.size > 0 && (
        <div className="st-warn">
          {conflicts.size} commands share a shortcut in overlapping scopes (amber rows).
        </div>
      )}
      <table className="tbl st-hk-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Shortcut</th>
            <th>Scope</th>
            <th>Default</th>
            <th />
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g}>
            <tr className="st-hk-group">
              <td colSpan={5}>{g}</td>
            </tr>
            {shown
              .filter((r) => r.c.group === g)
              .map((r) => {
                const conf = conflicts.get(r.c.id);
                return (
                  <tr
                    key={r.c.id}
                    data-conflict={conf ? 'true' : undefined}
                    data-testid={`hk-${r.c.id}`}
                  >
                    <td>
                      <span className="st-dot-slot">
                        {r.modified && <span className="st-mod" />}
                      </span>
                      {r.c.label}
                      {conf && (
                        <span className="st-conflict">
                          {' '}
                          — conflicts with {conf.map(label).join(', ')}
                        </span>
                      )}
                    </td>
                    <td>
                      <Recorder
                        value={r.shortcut}
                        label={r.c.label}
                        onRecord={(s) => set(r.c.id, { shortcut: s })}
                      />
                    </td>
                    <td>
                      <select
                        className="ht-select ht-select--sm"
                        aria-label={`Scope for ${r.c.label}`}
                        value={r.scope}
                        onChange={(e) => set(r.c.id, { scope: e.target.value as HotkeyScope })}
                      >
                        {HOTKEY_SCOPES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted mono">{defaultShortcut(r.c.id) ?? '—'}</td>
                    <td>
                      {r.modified && (
                        <button
                          className="ht-icon-btn"
                          aria-label={`Reset ${r.c.label}`}
                          onClick={() => {
                            const next = { ...value };
                            delete next[r.c.id];
                            onChange(next);
                          }}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        ))}
      </table>
      {!shown.length && <div className="tbl-empty">No commands match</div>}
    </div>
  );
}

// ------------------------------------------------------------------ sounds

export function SoundEventsEditor({
  value,
  onChange,
  draft,
}: EditorProps<Record<SoundEvent, SoundEventConfig>>) {
  const customs = draft['sounds.custom'];
  const master = draft['sounds.master'] / 100;
  const set = (id: SoundEvent, patch: Partial<SoundEventConfig>) =>
    onChange({ ...value, [id]: { ...value[id], ...patch } });
  return (
    <div className="st-list">
      {SOUND_EVENTS.map((e) => {
        const c = value[e.id];
        return (
          <div key={e.id} className="st-row" title={e.help}>
            <span className="st-row-label">
              <input
                type="checkbox"
                className="st-check"
                aria-label={`${e.label} sound on`}
                checked={c.enabled}
                onChange={(x) => set(e.id, { enabled: x.target.checked })}
              />
              {e.label}
            </span>
            <span className="st-row-ctl row gap8 center-y">
              <select
                className="ht-select ht-select--sm"
                aria-label={`${e.label} sound`}
                value={c.sound}
                onChange={(x) => set(e.id, { sound: x.target.value })}
              >
                {BUILTIN_SOUNDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
                {customs.map((s) => (
                  <option key={s.id} value={'custom:' + s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                type="range"
                className="ht-slider st-vol"
                min={0}
                max={100}
                aria-label={`${e.label} volume`}
                value={c.volume}
                onChange={(x) => set(e.id, { volume: Number(x.target.value) })}
              />
              <span className="tnum muted st-num">{c.volume}%</span>
              <button
                className="ht-icon-btn"
                aria-label={`Preview ${e.label}`}
                onClick={() => playSoundRef(c.sound, (c.volume / 100) * master)}
              >
                <Play size={12} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CustomSoundsEditor({ value, onChange, draft }: EditorProps<CustomSound[]>) {
  const fileRef = useRef<HTMLInputElement>(null);
  const add = (f: File) => {
    if (f.size > MAX_CUSTOM_SOUND_BYTES)
      return toast('error', 'File too large', 'Max 2 MB per sound.');
    if (value.length >= MAX_CUSTOM_SOUNDS)
      return toast('error', 'Too many sounds', 'Max 20 files.');
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result).replace(/^data:(?!audio\/)[^;]*;/, 'data:audio/mpeg;');
      onChange([
        ...value,
        { id: Date.now().toString(36), name: f.name.slice(0, 120), dataUrl: url },
      ]);
    };
    r.readAsDataURL(f);
  };
  return (
    <div className="st-list">
      {value.map((s) => (
        <div key={s.id} className="st-row">
          <span className="st-row-label">{s.name}</span>
          <span className="st-row-ctl row gap8">
            <button
              className="ht-icon-btn"
              aria-label={`Preview ${s.name}`}
              onClick={() => playSoundRef('custom:' + s.id, draft['sounds.master'] / 100)}
            >
              <Play size={12} />
            </button>
            <button
              className="ht-icon-btn"
              aria-label={`Remove ${s.name}`}
              onClick={() => onChange(value.filter((x) => x.id !== s.id))}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      ))}
      <div className="st-row">
        <Button size="xs" onClick={() => fileRef.current?.click()}>
          <Plus size={12} /> Add .wav / .mp3…
        </Button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".wav,.mp3,audio/wav,audio/mpeg"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) add(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ commission

let ruleSeq = 0;

export function CommissionRulesEditor({ value, onChange, draft }: EditorProps<CommissionRule[]>) {
  const accounts = [...paper.accounts.values()];
  const instruments = allInstruments(isTauri);
  const set = (id: string, patch: Partial<CommissionRule>) =>
    onChange(value.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const defaults = {
    makerPct: draft['commission.cryptoMakerPct'],
    takerPct: draft['commission.cryptoTakerPct'],
    perContractRT: draft['commission.futuresRT'],
  };
  const numCell = (
    r: CommissionRule,
    k: 'makerPct' | 'takerPct' | 'perContractRT',
    label: string,
    step: number,
  ) => (
    <input
      className="st-num-in tnum"
      type="number"
      step={step}
      aria-label={label}
      value={r[k]}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) set(r.id, { [k]: n });
      }}
    />
  );
  return (
    <div className="col gap8">
      <table className="tbl">
        <thead>
          <tr>
            <th>Account</th>
            <th>Instrument</th>
            <th>Maker %</th>
            <th>Taker %</th>
            <th>Per contract RT</th>
            <th>Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {value.map((r) => (
            <tr key={r.id}>
              <td>
                <select
                  className="ht-select ht-select--sm"
                  aria-label="Rule account"
                  value={r.accountId}
                  onChange={(e) => set(r.id, { accountId: e.target.value })}
                >
                  <option value="*">All accounts</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  className="ht-select ht-select--sm"
                  aria-label="Rule instrument"
                  value={r.instrumentId}
                  onChange={(e) => set(r.id, { instrumentId: e.target.value })}
                >
                  <option value="*">All instruments</option>
                  {instruments.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.symbol} — {i.exchange}
                    </option>
                  ))}
                </select>
              </td>
              <td>{numCell(r, 'makerPct', 'Maker %', 0.001)}</td>
              <td>{numCell(r, 'takerPct', 'Taker %', 0.001)}</td>
              <td>{numCell(r, 'perContractRT', 'Per contract round turn', 0.01)}</td>
              <td>
                <select
                  className="ht-select ht-select--sm"
                  aria-label="Rule source"
                  value={r.source}
                  onChange={(e) =>
                    set(r.id, { source: e.target.value as CommissionRule['source'] })
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="default">Default</option>
                  <option value="detected" disabled>
                    Detected (needs broker API)
                  </option>
                </select>
              </td>
              <td>
                <button
                  className="ht-icon-btn"
                  aria-label="Remove rule"
                  onClick={() => onChange(value.filter((x) => x.id !== r.id))}
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!value.length && (
        <div className="muted">No rules — the defaults apply to every account and instrument.</div>
      )}
      <div className="row gap8">
        <Button
          size="xs"
          onClick={() =>
            onChange([
              ...value,
              {
                id: `r${Date.now().toString(36)}${ruleSeq++}`,
                accountId: '*',
                instrumentId: '*',
                ...defaults,
                source: 'manual',
              },
            ])
          }
        >
          <Plus size={12} /> Add rule
        </Button>
        <Button
          size="xs"
          disabled
          title="Reading fee tiers from exchange / broker APIs arrives with the connectors (P05)"
        >
          Refresh from exchanges
        </Button>
      </div>
      <div className="st-subhead">Effective commission (first paper account)</div>
      <table className="tbl">
        <tbody>
          {instruments.slice(0, 12).map((i) => {
            const c = resolveCommission(value, defaults, accounts[0]?.id ?? '', i.id);
            const fut = i.tickValue > 0;
            return (
              <tr key={i.id}>
                <td>{i.symbol}</td>
                <td className="muted">{fut ? 'Futures' : 'Crypto / linear'}</td>
                <td className="tnum">
                  {fut
                    ? `$${c.perContractRT.toFixed(2)} / contract RT`
                    : `maker ${c.makerPct}% · taker ${c.takerPct}%`}
                </td>
                <td className="muted">{c.ruleId ? 'Rule' : 'Default'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ exchange clocks

export function ClocksEditor({ value, onChange, draft }: EditorProps<string[]>) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(i);
  }, []);
  const hour12 = !draft['general.clock24h'];
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Follow</th>
          <th>Exchange</th>
          <th>Local time</th>
          <th>Status</th>
          <th>Hours</th>
        </tr>
      </thead>
      <tbody>
        {EXCHANGES.map((ex) => {
          const st = exchangeStatus(ex, now);
          return (
            <tr key={ex.id} data-testid={`clock-${ex.id}`}>
              <td>
                <input
                  type="checkbox"
                  className="st-check"
                  aria-label={`Follow ${ex.name}`}
                  checked={value.includes(ex.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...value, ex.id] : value.filter((x) => x !== ex.id),
                    )
                  }
                />
              </td>
              <td>{ex.name}</td>
              <td className="tnum" title={ex.tz}>
                {now.toLocaleTimeString('en-GB', {
                  timeZone: ex.tz,
                  hour12,
                  hour: '2-digit',
                  minute: '2-digit',
                  weekday: 'short',
                })}
              </td>
              <td>
                <Badge kind={st.open ? 'live' : 'default'}>
                  <Circle size={6} fill="currentColor" /> {st.open ? 'Open' : 'Closed'}
                </Badge>{' '}
                <span className="muted">
                  {Number.isFinite(st.minutesToChange)
                    ? `${st.open ? 'closes' : 'opens'} in ${formatDuration(st.minutesToChange)}`
                    : ''}
                </span>
              </td>
              <td className="muted">{ex.note}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
