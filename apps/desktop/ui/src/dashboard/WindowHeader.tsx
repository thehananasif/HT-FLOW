import type { IDockviewPanelHeaderProps } from 'dockview';
import { Camera, Maximize2, Settings2, X } from 'lucide-react';
import { Badge, Chip, DropdownMenu, IconButton, MenuTrigger, type MenuEntry } from '@htflow/ui-kit';
import { specLabel, TIMEFRAME_PRESETS, type BarSpec } from '@htflow/market-data';
import {
  CHART_TEMPLATES,
  LINK_COLORS,
  PENDING_TEMPLATES,
  windowTitle,
  type ChartWindowState,
  type LinkColor,
  type WindowState,
} from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { allInstruments, instrumentById } from '../state/instruments';
import { isTauri } from '../backend';
import { hub } from '../state/market';
import { moduleDef } from '../shell/modules';

const QUICK_TF: BarSpec[] = [
  { kind: 'time', ms: 60_000 },
  { kind: 'time', ms: 300_000 },
  { kind: 'time', ms: 3_600_000 },
];

const sameSpec = (a: BarSpec, b: BarSpec) => JSON.stringify(a) === JSON.stringify(b);

function LinkDot({ id, link }: { id: string; link: LinkColor }) {
  const patch = useWindows((s) => s.patch);
  return (
    <DropdownMenu
      trigger={
        <button
          className="link-dot"
          aria-label={`Link group: ${link}`}
          title={`Link group: ${link}`}
        >
          <span style={{ background: LINK_COLORS[link] }} />
        </button>
      }
      items={(Object.keys(LINK_COLORS) as LinkColor[]).map((c) => ({
        id: c,
        label: c === 'none' ? 'No link' : c[0]!.toUpperCase() + c.slice(1),
        checked: c === link,
        onSelect: () => patch(id, { link: c } as Partial<WindowState>),
      }))}
    />
  );
}

function InstrumentMenu({ id, instrumentId }: { id: string; instrumentId: string }) {
  const patch = useWindows((s) => s.patch);
  const inst = instrumentById(instrumentId);
  const all = allInstruments(isTauri);
  const groups = [
    ...new Set(all.map((i) => (i.id.startsWith('mock:') ? 'Simulated (MockFeed)' : i.exchange))),
  ];
  const items: MenuEntry[] = groups.flatMap((g) => [
    { kind: 'label' as const, id: 'l-' + g, label: g },
    ...all
      .filter((i) => (i.id.startsWith('mock:') ? 'Simulated (MockFeed)' : i.exchange) === g)
      .map((i) => ({
        id: i.id,
        label: `${i.symbol} · ${i.exchange}`,
        checked: i.id === instrumentId,
        onSelect: () => patch(id, { instrumentId: i.id } as Partial<WindowState>),
      })),
  ]);
  if (!isTauri)
    items.push({ kind: 'label', id: 'live-note', label: 'Live crypto venues: desktop app' });
  return (
    <DropdownMenu
      items={items}
      trigger={
        <button className="hdr-symbol" data-testid="instrument-picker">
          {inst?.symbol ?? instrumentId} <span className="caret">▾</span>
        </button>
      }
    />
  );
}

function FeedBadge({ instrumentId }: { instrumentId: string }) {
  const st = hub.peek(instrumentId)?.status.state ?? 'connecting';
  if (instrumentId.startsWith('mock:')) return <Badge kind="replay">Sim</Badge>;
  if (st === 'live') return <Badge kind="live">Live</Badge>;
  if (st === 'error' || st === 'disconnected') return <Badge kind="error">{st}</Badge>;
  return <Badge kind="delayed">{st}</Badge>;
}

function ChartControls({ id, s }: { id: string; s: ChartWindowState }) {
  const patch = useWindows((st) => st.patch);
  const set = (p: Partial<ChartWindowState>) => patch(id, p as Partial<WindowState>);
  const tpl = CHART_TEMPLATES.find((t) => t.id === s.template)!;
  const tfItems: MenuEntry[] = TIMEFRAME_PRESETS.map((row) => ({
    kind: 'submenu' as const,
    id: row.row,
    label: row.row,
    items: row.specs.map((sp) => ({
      id: JSON.stringify(sp),
      label: specLabel(sp),
      checked: sameSpec(sp, s.timeframe as BarSpec),
      onSelect: () => set({ timeframe: sp as ChartWindowState['timeframe'] }),
    })),
  }));
  return (
    <>
      {s.template === 'liquidity-map' ? (
        ([250, 1000, 5000] as const).map((ms) => (
          <Chip key={ms} selected={s.heatColumnMs === ms} onClick={() => set({ heatColumnMs: ms })}>
            {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
          </Chip>
        ))
      ) : (
        <>
          {QUICK_TF.map((sp) => (
            <Chip
              key={JSON.stringify(sp)}
              variant="ghost"
              selected={sameSpec(sp, s.timeframe as BarSpec)}
              onClick={() => set({ timeframe: sp as ChartWindowState['timeframe'] })}
            >
              {specLabel(sp)}
            </Chip>
          ))}
          {!QUICK_TF.some((q) => sameSpec(q, s.timeframe as BarSpec)) && (
            <Chip selected>{specLabel(s.timeframe as BarSpec)}</Chip>
          )}
          <DropdownMenu
            items={tfItems}
            trigger={<MenuTrigger aria-label="Timeframe">TF</MenuTrigger>}
          />
        </>
      )}
      <span className="hdr-lots tnum" title="Order quantity">
        <input
          aria-label="Lots"
          value={s.lots}
          onChange={(e) =>
            set({ lots: Math.max(0, Number(e.target.value.replace(/[^\d.]/g, '')) || 0) })
          }
        />
        Lots
      </span>
      <DropdownMenu
        items={[
          { kind: 'label', id: 'b', label: 'Built-in templates' },
          ...CHART_TEMPLATES.map((t) => ({
            id: t.id,
            label: t.label,
            checked: t.id === s.template,
            onSelect: () =>
              set({
                template: t.id,
                timeframe: t.id === 'candles-vp' ? { kind: 'time', ms: 60_000 } : s.timeframe,
              }),
          })),
          ...PENDING_TEMPLATES.map((label) => ({
            id: label,
            label: `${label} (P09)`,
            disabled: true,
          })),
          { kind: 'separator', id: 's' },
          { id: 'save', label: 'Settings · Save current as template… (P34)', disabled: true },
        ]}
        trigger={
          <MenuTrigger data-testid="template-menu">
            {tpl.label === 'Japanese Candlesticks with Volume Profile'
              ? 'Candlesticks + Volume Profile'
              : tpl.label}
          </MenuTrigger>
        }
      />
      <button
        className="ht-chip ht-chip--ghost hdr-indicators"
        disabled
        title="Indicators dialog arrives in P13"
      >
        Indicators
      </button>
    </>
  );
}

/** Window header rendered as the dockview tab (single-tab groups go full width). */
export function WindowHeader(props: IDockviewPanelHeaderProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]);
  const multi = (props.api.group?.panels.length ?? 1) > 1;
  if (!s) return <div className="win-hdr">{props.api.title}</div>;
  const inst = s.kind !== 'module' ? instrumentById(s.instrumentId) : undefined;
  if (multi) {
    return (
      <div className="win-hdr win-hdr--tab">
        {s.kind !== 'module' && (
          <span className="hdr-link" style={{ background: LINK_COLORS[s.link] }} />
        )}
        {windowTitle(s, inst?.symbol ?? '')}
        <button className="ht-icon-btn" aria-label="Close window" onClick={() => props.api.close()}>
          <X size={13} />
        </button>
      </div>
    );
  }
  return (
    <div className="win-hdr" data-testid={`win-hdr-${id}`}>
      <span className="hdr-grip" aria-hidden="true" />
      {s.kind !== 'module' ? (
        <>
          <LinkDot id={id} link={s.link} />
          <InstrumentMenu id={id} instrumentId={s.instrumentId} />
          {s.kind === 'chart' ? (
            <ChartControls id={id} s={s} />
          ) : (
            <>
              <span className="hdr-account">••••3505 ▾</span>
              <span className="hdr-lots tnum">
                <input
                  aria-label="Lots"
                  value={s.lots}
                  onChange={(e) =>
                    useWindows
                      .getState()
                      .patch(id, { lots: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
                Lots
              </span>
              <FeedBadge instrumentId={s.instrumentId} />
              <DropdownMenu
                items={[1, 2, 5, 10].map((g) => ({
                  id: String(g),
                  label: `${g} tick${g > 1 ? 's' : ''} per row`,
                  checked: s.grouping === g,
                  onSelect: () => useWindows.getState().patch(id, { grouping: g }),
                }))}
                trigger={<MenuTrigger>{s.grouping}x</MenuTrigger>}
              />
            </>
          )}
        </>
      ) : (
        <span className="hdr-title">{moduleDef(s.module)?.label ?? s.module}</span>
      )}
      <div className="grow" />
      {s.kind === 'chart' && (
        <span className="hdr-center">
          Chart <FeedBadge instrumentId={s.instrumentId} />
        </span>
      )}
      <div className="grow" />
      {s.kind === 'chart' && (
        <IconButton
          label="Snapshot (copy PNG)"
          onClick={() => window.dispatchEvent(new CustomEvent('htflow:snapshot', { detail: id }))}
        >
          <Camera size={13} />
        </IconButton>
      )}
      <IconButton
        label="Maximize"
        onClick={() => (props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize())}
      >
        <Maximize2 size={12} />
      </IconButton>
      <IconButton label="Settings" disabled title="Chart settings window arrives in P34">
        <Settings2 size={13} />
      </IconButton>
      <IconButton label="Close window" onClick={() => props.api.close()}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
