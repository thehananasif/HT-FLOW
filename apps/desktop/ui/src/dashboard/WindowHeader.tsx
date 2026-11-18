import { useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { Camera, CircleHelp, Maximize2, Settings2, X } from 'lucide-react';
import { helpTopicFor, openGuide } from '../modules/user-guide/topics';
import { Badge, Chip, DropdownMenu, IconButton, MenuTrigger } from '@htflow/ui-kit';
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
import { instrumentById } from '../state/instruments';
import { InstrumentPickerButton } from '../components/InstrumentPicker';
import { hub } from '../state/market';
import { moduleDef } from '../shell/modules';
import { chartHeaderItems } from '../charts/extensions';
import { openChartSettings, snapshotMenuItems, templateMenuItems } from '../charts/headerMenu';
import { useChartSnapshots } from '../charts/snapshotStore';
import { TimeframeHeader } from '../charts/timeframes/TimeframeDialog';
import { confirmAction } from '../state/confirm';
import { WindowMenuButton } from '../modules/workspaces/WindowMenu';

import { translateLiteral as tl } from '@htflow/i18n';
/** Closes a window, asking first when Settings → General → Confirmations requires it. */
function closeWindow(api: IDockviewPanelHeaderProps['api']): void {
  const w = useWindows.getState().windows[api.id];
  void confirmAction(
    'closeWindow',
    { title: 'Close window', body: `Close "${api.title}"?`, confirmLabel: 'Close' },
    { module: w?.kind === 'module' },
  ).then((ok) => ok && api.close());
}

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
  return (
    <InstrumentPickerButton
      className="hdr-symbol"
      testId="instrument-picker"
      value={instrumentId}
      onPick={(_e, feedId) => {
        if (feedId) patch(id, { instrumentId: feedId } as Partial<WindowState>);
      }}
    >
      {inst?.symbol ?? instrumentId} <span className="caret">▾</span>
    </InstrumentPickerButton>
  );
}

function FeedBadge({ instrumentId }: { instrumentId: string }) {
  const st = hub.peek(instrumentId)?.status.state ?? 'connecting';
  if (instrumentId.startsWith('replay:')) return <Badge kind="replay">{tl('Replay')}</Badge>;
  if (instrumentId.startsWith('mock:')) return <Badge kind="replay">{tl('Sim')}</Badge>;
  if (st === 'live') return <Badge kind="live">{tl('Live')}</Badge>;
  if (st === 'error' || st === 'disconnected') return <Badge kind="error">{st}</Badge>;
  return <Badge kind="delayed">{st}</Badge>;
}

function ChartControls({ id, s }: { id: string; s: ChartWindowState }) {
  // Re-render the template menu when snapshots change.
  useChartSnapshots((st) => st.list);
  const patch = useWindows((st) => st.patch);
  const set = (p: Partial<ChartWindowState>) => patch(id, p as Partial<WindowState>);
  const tpl = CHART_TEMPLATES.find((t) => t.id === s.template)!;
  return (
    <>
      {s.template === 'liquidity-map' ? (
        ([250, 1000, 5000] as const).map((ms) => (
          <Chip key={ms} selected={s.heatColumnMs === ms} onClick={() => set({ heatColumnMs: ms })}>
            {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
          </Chip>
        ))
      ) : (
        <TimeframeHeader windowId={id} s={s} />
      )}
      <span className="hdr-lots tnum" title={tl('Order quantity')}>
        <input
          aria-label={tl('Lots')}
          value={s.lots}
          onChange={(e) =>
            set({ lots: Math.max(0, Number(e.target.value.replace(/[^\d.]/g, '')) || 0) })
          }
        />
        {tl('Lots')}
      </span>
      <DropdownMenu
        items={[
          ...snapshotMenuItems(id),
          { kind: 'separator', id: 'snap-sep' },
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
          ...templateMenuItems(id),
        ]}
        trigger={
          <MenuTrigger data-testid="template-menu">
            {tpl.label === 'Japanese Candlesticks with Volume Profile'
              ? 'Candlesticks + Volume Profile'
              : tpl.label}
          </MenuTrigger>
        }
      />
      {chartHeaderItems().map((h) => (
        <h.Component key={h.id} windowId={id} state={s} />
      ))}
    </>
  );
}

/** Window header rendered as the dockview tab (single-tab groups go full width). */
export function WindowHeader(props: IDockviewPanelHeaderProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]);
  // Re-render when panels join / leave the group (tab form vs full-width header).
  const [, bump] = useState(0);
  useEffect(() => {
    const c = props.containerApi;
    const subs = [c.onDidAddPanel, c.onDidRemovePanel, c.onDidMovePanel].map((ev) =>
      ev(() => bump((x) => x + 1)),
    );
    return () => subs.forEach((d) => d.dispose());
  }, [props.containerApi]);
  const multi = (props.api.group?.panels.length ?? 1) > 1;
  if (!s) return <div className="win-hdr">{tl(props.api.title)}</div>;
  const inst = s.kind !== 'module' ? instrumentById(s.instrumentId) : undefined;
  if (multi) {
    return (
      <div className="win-hdr win-hdr--tab">
        {s.kind !== 'module' && (
          <span className="hdr-link" style={{ background: LINK_COLORS[s.link] }} />
        )}
        {windowTitle(s, inst?.symbol ?? '')}
        <button
          className="ht-icon-btn"
          aria-label={tl('Close window')}
          onClick={() => closeWindow(props.api)}
        >
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
                  aria-label={tl('Lots')}
                  value={s.lots}
                  onChange={(e) =>
                    useWindows
                      .getState()
                      .patch(id, { lots: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
                {tl('Lots')}
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
          {tl('Chart')} <FeedBadge instrumentId={s.instrumentId} />
        </span>
      )}
      <div className="grow" />
      {s.kind === 'chart' && (
        <IconButton
          label={tl('Snapshot (copy PNG)')}
          onClick={() => window.dispatchEvent(new CustomEvent('htflow:snapshot', { detail: id }))}
        >
          <Camera size={13} />
        </IconButton>
      )}
      <IconButton
        label={tl('Help for this panel')}
        data-testid={`help-${id}`}
        onClick={() => openGuide(helpTopicFor(s))}
      >
        <CircleHelp size={13} />
      </IconButton>
      <WindowMenuButton id={id} />
      <IconButton
        label={tl('Maximize')}
        onClick={() => (props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize())}
      >
        <Maximize2 size={12} />
      </IconButton>
      <IconButton
        label={tl('Settings')}
        disabled={s.kind !== 'chart'}
        title={s.kind === 'chart' ? 'Chart settings (Ctrl+S)' : 'Settings'}
        onClick={() => s.kind === 'chart' && openChartSettings(id)}
      >
        <Settings2 size={13} />
      </IconButton>
      <IconButton label={tl('Close window')} onClick={() => closeWindow(props.api)}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
