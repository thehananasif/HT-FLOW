import { useMemo, useState } from 'react';
import { Activity, Bell, Star } from 'lucide-react';
import {
  applyTheme,
  Badge,
  Button,
  Checkbox,
  Chip,
  ColorPicker,
  ColorSwatch,
  Combobox,
  ContextMenu,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  FontPicker,
  GradientEditor,
  LineStylePicker,
  MenuSlider,
  Sheet,
  SplitPane,
  Table,
  TreeView,
  type ComboOption,
  type GradientStop,
  type LineStyle,
  type SortState,
  type TreeNode,
  IconButton,
  Input,
  Kbd,
  MenuTrigger,
  NumberInput,
  RibbonButton,
  SegmentedControl,
  Select,
  Skeleton,
  Slider,
  StatusPill,
  Tabs,
  Toggle,
  toast,
  type ThemeName,
} from '@htflow/ui-kit';

const INSTRUMENTS: ComboOption[] = [
  { value: 'ES', label: 'ES', hint: 'E-mini S&P 500' },
  { value: 'NQ', label: 'NQ', hint: 'E-mini Nasdaq-100' },
  { value: 'CL', label: 'CL', hint: 'Crude Oil' },
  { value: 'GC', label: 'GC', hint: 'Gold' },
  { value: 'BTCUSDT', label: 'BTCUSDT', hint: 'Bybit linear' },
  { value: 'ETHUSDT', label: 'ETHUSDT', hint: 'Bybit linear' },
];

const TREE: TreeNode[] = [
  {
    id: 'indicators',
    label: 'Indicators',
    children: [
      { id: 'vwap', label: 'VWAP' },
      { id: 'ema', label: 'EMA' },
      {
        id: 'vol',
        label: 'Volume',
        children: [
          { id: 'cvd', label: 'CVD' },
          { id: 'oi', label: 'Open interest' },
        ],
      },
    ],
  },
  {
    id: 'drawings',
    label: 'Drawings',
    children: [
      { id: 'trend', label: 'Trend line' },
      { id: 'fib', label: 'Fib retracement' },
    ],
  },
  { id: 'alerts', label: 'Alerts' },
];

interface DemoRow {
  id: string;
  symbol: string;
  price: number;
  chg: number;
}
const ROWS: DemoRow[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `r${i}`,
  symbol: `SYM${String(i).padStart(4, '0')}`,
  price: 100 + ((i * 7919) % 5000) / 10,
  chg: (((i * 104729) % 400) - 200) / 100,
}));

/** Dev-only UI Gallery (P02 acceptance): every ui-kit component in its states. Open with ?gallery. */
export function Gallery() {
  const [themeName, setTheme] = useState<ThemeName>('dark');
  const [seg, setSeg] = useState('a');
  const [tab, setTab] = useState('one');
  const [num, setNum] = useState(4050.25);
  const [chk, setChk] = useState(true);
  const [tog, setTog] = useState(false);
  const [sl, setSl] = useState(40);
  const [col, setCol] = useState('#20C77A');
  const [dlg, setDlg] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [fill, setFill] = useState('#20c77a80');
  const [swatches, setSwatches] = useState<string[]>(['#20c77a', '#f04a5d']);
  const [stops, setStops] = useState<GradientStop[]>([
    { pos: 0, color: '#4fa3f7' },
    { pos: 0.5, color: '#b07cf0' },
    { pos: 1, color: '#f04a5d' },
  ]);
  const [inst, setInst] = useState<string | null>('ES');
  const [font, setFont] = useState('Geist');
  const [line, setLine] = useState<LineStyle>({ dash: 'dashed', width: 2 });
  const [menuSl, setMenuSl] = useState(60);
  const [sort, setSort] = useState<SortState | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set(['vwap']));
  const [ratio, setRatio] = useState(0.4);
  const rows = useMemo(() => ROWS, []);
  const loadInstruments = (q: string) =>
    new Promise<ComboOption[]>((res) =>
      setTimeout(
        () =>
          res(INSTRUMENTS.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))),
        200,
      ),
    );
  const section = (title: string, children: React.ReactNode) => (
    <section className="gal-sec">
      <h3>{title}</h3>
      <div className="row gap8 wrap center-y">{children}</div>
    </section>
  );
  return (
    <div className="gallery">
      <h1>UI Gallery</h1>
      {section(
        'Theme',
        <SegmentedControl
          value={themeName}
          onChange={(v) => {
            setTheme(v);
            applyTheme(v);
          }}
          options={(['dark', 'dark-blue', 'gray', 'light', 'high-contrast'] as ThemeName[]).map(
            (v) => ({ value: v, label: v }),
          )}
        />,
      )}
      {section(
        'Buttons',
        <>
          {(
            [
              'primary',
              'secondary',
              'outline',
              'buy',
              'sell',
              'buy-outline',
              'sell-outline',
              'destructive',
              'ghost',
            ] as const
          ).map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
          <Button disabled>disabled</Button>
          <Button size="sm">small</Button>
          <Button size="xs">xs</Button>
        </>,
      )}
      {section(
        'Icon & ribbon buttons',
        <>
          <IconButton label="Star">
            <Star size={14} />
          </IconButton>
          <IconButton label="Active" active>
            <Bell size={14} />
          </IconButton>
          <RibbonButton icon={<Activity />} label="Chart" hasMenu />
          <RibbonButton icon={<Activity />} label="Active" active />
          <RibbonButton icon={<Activity />} label="Compact" compact />
        </>,
      )}
      {section(
        'Segmented, chips, tabs',
        <>
          <SegmentedControl
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: 'M5' },
              { value: 'b', label: 'H1' },
              { value: 'c', label: 'D' },
            ]}
          />
          <Chip selected>Selected</Chip>
          <Chip>Chip</Chip>
          <Chip variant="ghost">Ghost</Chip>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'one', label: 'Visual' },
              { value: 'two', label: 'Footprint' },
              { value: 'three', label: 'Trading' },
            ]}
          />
        </>,
      )}
      {section(
        'Inputs',
        <>
          <Field label="Text">
            <Input placeholder="Type…" />
          </Field>
          <Field label="Invalid" error="Required">
            <Input invalid />
          </Field>
          <Field label="Price (tick 0.25)">
            <NumberInput value={num} onChange={setNum} step={0.25} />
          </Field>
          <Field label="Select">
            <Select
              value="gtc"
              onChange={() => {}}
              options={[
                { value: 'gtc', label: 'GTC' },
                { value: 'day', label: 'DAY' },
              ]}
            />
          </Field>
          <Checkbox checked={chk} onChange={setChk} label="Checkbox" />
          <Checkbox radio checked={chk} onChange={setChk} label="Radio" />
          <Toggle checked={tog} onChange={setTog} label="Toggle" />
          <div style={{ width: 160 }}>
            <Slider value={sl} onChange={setSl} label="Slider" />
          </div>
          <ColorSwatch value={col} onChange={setCol} label="Colour" />
        </>,
      )}
      {section(
        'Badges & pills',
        <>
          <Badge>Default</Badge>
          <Badge kind="live">Live</Badge>
          <Badge kind="delayed">Delayed 15m</Badge>
          <Badge kind="replay">Replay</Badge>
          <Badge kind="error">Error</Badge>
          <Badge kind="free">FREE</Badge>
          <StatusPill state="live" label="Binance Futures" />
          <StatusPill state="delayed" label="dxFeed (15-min delayed)" />
          <StatusPill state="error" label="Rithmic" />
          <Kbd>Ctrl+K</Kbd>
        </>,
      )}
      {section(
        'Menus, dialog, toast',
        <>
          <DropdownMenu
            trigger={<MenuTrigger>Dropdown</MenuTrigger>}
            items={[
              { id: 'a', label: 'Item', shortcut: 'Ctrl+A' },
              { id: 'b', label: 'Checked', checked: true },
              { kind: 'separator', id: 's' },
              { kind: 'submenu', id: 'c', label: 'Submenu', items: [{ id: 'd', label: 'Nested' }] },
              { id: 'e', label: 'Disabled', disabled: true },
            ]}
          />
          <ContextMenu items={[{ id: 'x', label: 'Context item', shortcut: 'Del' }]}>
            <div className="gal-ctx">Right-click me</div>
          </ContextMenu>
          <Button onClick={() => setDlg(true)}>Open dialog</Button>
          <Button onClick={() => toast('success', 'Order filled', 'Buy 1 @ 4050.25')}>Toast</Button>
          <Dialog
            open={dlg}
            onOpenChange={setDlg}
            title="Dialog title"
            description="Dialog description"
          >
            <Button variant="primary" onClick={() => setDlg(false)}>
              Close
            </Button>
          </Dialog>
        </>,
      )}
      {section(
        'Colour picker v2 (RGBA, swatches, recent)',
        <>
          <ColorPicker
            label="Fill colour"
            value={fill}
            onChange={setFill}
            swatches={swatches}
            onSwatchesChange={setSwatches}
          />
          <span className="mono" style={{ fontSize: 11 }}>
            {fill}
          </span>
        </>,
      )}
      {section(
        'Gradient editor',
        <GradientEditor stops={stops} onChange={setStops} label="Heatmap gradient" />,
      )}
      {section(
        'Combobox, font & line style',
        <>
          <Combobox
            aria-label="Instrument"
            value={inst}
            onChange={(v) => setInst(v)}
            options={INSTRUMENTS}
          />
          <Combobox
            aria-label="Instrument (async)"
            value={inst}
            valueLabel={inst ?? undefined}
            onChange={(v) => setInst(v)}
            loadOptions={loadInstruments}
          />
          <div style={{ width: 260 }}>
            <FontPicker value={font} onChange={setFont} />
          </div>
          <LineStylePicker value={line} onChange={setLine} />
        </>,
      )}
      {section(
        'Slider in a menu, sheet',
        <>
          <DropdownMenu
            trigger={<MenuTrigger>Opacity menu</MenuTrigger>}
            items={[
              { id: 'i', label: 'Item' },
              {
                kind: 'slider',
                id: 'op',
                label: 'Opacity',
                value: menuSl,
                format: (v) => `${v}%`,
                onChange: setMenuSl,
              },
            ]}
          />
          <div style={{ width: 200 }}>
            <MenuSlider label="Standalone" value={menuSl} onChange={setMenuSl} />
          </div>
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <Sheet
            open={sheet}
            onOpenChange={setSheet}
            title="Sheet title"
            description="Side drawer with focus trap."
            footer={
              <Button variant="primary" onClick={() => setSheet(false)}>
                Done
              </Button>
            }
          >
            <TreeView aria-label="Sheet tree" nodes={TREE} defaultExpanded={['indicators']} />
          </Sheet>
        </>,
      )}
      {section(
        'Virtualized table (2,000 rows)',
        <div style={{ width: 460, height: 220 }}>
          <Table<DemoRow>
            aria-label="Demo table"
            rows={rows}
            rowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            selectionMode="multi"
            selected={sel}
            onSelectionChange={setSel}
            columns={[
              { key: 'symbol', header: 'Symbol', sortable: true },
              {
                key: 'price',
                header: 'Price',
                sortable: true,
                numeric: true,
                width: 90,
                render: (r) => r.price.toFixed(2),
              },
              {
                key: 'chg',
                header: 'Chg',
                sortable: true,
                numeric: true,
                width: 80,
                render: (r) => (
                  <span style={{ color: r.chg >= 0 ? 'var(--ht-up)' : 'var(--ht-down)' }}>
                    {r.chg.toFixed(2)}
                  </span>
                ),
              },
            ]}
          />
        </div>,
      )}
      {section(
        'Tree view (checkboxes) & split pane',
        <>
          <div style={{ width: 220, border: '1px solid var(--ht-border)', borderRadius: 10 }}>
            <TreeView
              aria-label="Demo tree"
              nodes={TREE}
              checkable
              checked={checked}
              onCheckedChange={setChecked}
            />
          </div>
          <div
            style={{
              width: 420,
              height: 120,
              border: '1px solid var(--ht-border)',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <SplitPane defaultRatio={ratio} minA={80} minB={80} onRatioChange={setRatio}>
              <div style={{ padding: 8 }}>Pane A ({Math.round(ratio * 100)}%)</div>
              <div style={{ padding: 8 }}>Pane B</div>
            </SplitPane>
          </div>
        </>,
      )}
      {section(
        'Empty state & skeleton',
        <>
          <div
            style={{
              width: 320,
              height: 160,
              border: '1px solid var(--ht-border)',
              borderRadius: 10,
            }}
          >
            <EmptyState title="No data">Connect a feed to start streaming.</EmptyState>
          </div>
          <Skeleton width={200} height={16} />
        </>,
      )}
    </div>
  );
}
