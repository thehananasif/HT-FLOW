import { useState } from 'react';
import { Activity, Bell, Star } from 'lucide-react';
import {
  applyTheme,
  Badge,
  Button,
  Checkbox,
  Chip,
  ColorSwatch,
  ContextMenu,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
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
