import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  ColorSwatch,
  Input,
  NumberInput,
  Select,
  Tabs,
  theme,
  toast,
} from '@htflow/ui-kit';
import { registerModule, type ModuleViewProps } from '../registry';
import { paper, PAPER_ACCOUNT } from '../../state/market';
import {
  CURRENCIES,
  createPaperAccount,
  deletePaperAccount,
  maskId,
  pickableAccounts,
  selectAccount,
} from '../../trading/accounts';
import { confirmAction } from '../../trading/confirm';
import {
  CONFIRM_KINDS,
  DEFAULT_CHART_PREFS,
  setChartPrefs,
  setPrefs,
  useTradingPrefs,
  type ChartTradingPrefs,
} from '../../trading/prefs';
import { SETUP_MODULE, useSetupNav, type SetupTab } from '../../trading/setupNav';
import { usePaperTick } from '../../trading/TradingPanel';
import { AtmEditor } from './AtmEditor';
// Chart order lines and trading commands load with this module (auto-imported at startup).
import '../../trading/chartTrading';
import '../../trading/commands';
import '../../trading/trading.css';
import './styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
const TABS: { value: SetupTab; label: string }[] = [
  { value: 'atm', label: 'ATM templates' },
  { value: 'accounts', label: 'Paper accounts' },
  { value: 'confirm', label: 'Order confirmations' },
  { value: 'chart', label: 'Chart trading' },
];

/* ---------------- paper accounts ---------------- */

function AccountRow({ id }: { id: string }) {
  const a = paper.accounts.get(id)!;
  const prefs = useTradingPrefs();
  const [name, setName] = useState(a.name);
  const [start, setStart] = useState(a.startingBalance);
  const [currency, setCurrency] = useState(a.currency);
  const [slip, setSlip] = useState(a.slippageTicks ?? 0);
  useEffect(() => {
    setName(a.name);
    setStart(a.startingBalance);
    setCurrency(a.currency);
    setSlip(a.slippageTicks ?? 0);
  }, [a.name, a.startingBalance, a.currency, a.slippageTicks]);
  const active = prefs.activeAccount === id;
  return (
    <tr data-testid="paper-account" data-id={id}>
      <td>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (!paper.renameAccount(id, name)) setName(a.name);
          }}
          aria-label={tl('Account name')}
        />
        <div className="muted tnum pa-id">{maskId(id)}</div>
      </td>
      <td className="tnum">
        {a.balance.toFixed(2)}
        <div className={`pa-pnl ${a.balance >= a.startingBalance ? 'up' : 'down'}`}>
          {(a.balance - a.startingBalance).toFixed(2)}
        </div>
      </td>
      <td>
        <NumberInput
          value={start}
          onChange={setStart}
          min={0}
          step={1000}
          aria-label={tl('Starting balance')}
        />
      </td>
      <td>
        <Select
          small
          value={currency}
          onChange={setCurrency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          aria-label={tl('Currency')}
        />
      </td>
      <td>
        <NumberInput
          value={slip}
          onChange={(v) => {
            setSlip(v);
            paper.updateAccount(id, { slippageTicks: v });
          }}
          min={0}
          max={100}
          unit="T"
          aria-label={tl('Slippage ticks')}
        />
      </td>
      <td className="pa-actions">
        <Button size="sm" disabled={active} onClick={() => selectAccount(id)}>
          {active ? 'Active' : 'Use'}
        </Button>
        <Button
          size="sm"
          disabled={start === a.startingBalance && currency === a.currency}
          onClick={() =>
            void confirmAction('close', 'Apply starting balance?', [
              `${a.name}: ${start.toFixed(2)} ${currency}`,
              'The account is reset: positions and orders are removed.',
            ]).then((ok) => ok && paper.setStartingBalance(id, start, currency))
          }
        >
          {tl('Apply')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (window.confirm(`Reset ${a.name}? Positions and orders are removed.`))
              paper.resetAccount(id);
          }}
        >
          {tl('Reset')}
        </Button>
        <Button
          size="sm"
          disabled={id === PAPER_ACCOUNT}
          title={id === PAPER_ACCOUNT ? 'The default account cannot be deleted' : 'Delete'}
          onClick={() => {
            if (window.confirm(`Delete ${a.name}? This cannot be undone.`)) deletePaperAccount(id);
          }}
        >
          {tl('Delete')}
        </Button>
      </td>
    </tr>
  );
}

function AccountsTab() {
  usePaperTick();
  const [name, setName] = useState('');
  const [start, setStart] = useState(50_000);
  const [currency, setCurrency] = useState('USD');
  const replay = [...paper.accounts.values()].filter((a) => a.kind === 'replay');
  return (
    <div className="pa-tab">
      <table className="pa-table">
        <thead>
          <tr>
            <th>{tl('Account')}</th>
            <th>{tl('Balance')}</th>
            <th>{tl('Starting balance')}</th>
            <th>{tl('Currency')}</th>
            <th>{tl('Slippage')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pickableAccounts().map((a) => (
            <AccountRow key={a.id} id={a.id} />
          ))}
        </tbody>
      </table>
      <form
        className="row gap8 center-y pa-new"
        onSubmit={(e) => {
          e.preventDefault();
          const a = createPaperAccount(
            name || `Paper ${pickableAccounts().length + 1}`,
            start,
            currency,
          );
          toast('success', tl('Paper account created'), a.name);
          setName('');
        }}
      >
        <b>{tl('New account')}</b>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tl('Name')}
          aria-label={tl('New account name')}
        />
        <NumberInput
          value={start}
          onChange={setStart}
          min={0}
          step={1000}
          aria-label={tl('New starting balance')}
        />
        <Select
          small
          value={currency}
          onChange={setCurrency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          aria-label={tl('New account currency')}
        />
        <Button type="submit" variant="primary" data-testid="create-paper-account">
          {tl('Create')}
        </Button>
      </form>
      {replay.length > 0 && (
        <p className="muted pa-note">
          {tl('Replay instruments always trade')} {replay.map((a) => a.name).join(', ')}{' '}
          {tl(
            '(routed automatically). Broker accounts appear here once a broker connector is added; none is available yet.',
          )}
        </p>
      )}
    </div>
  );
}

/* ---------------- confirmations ---------------- */

function ConfirmTab() {
  const prefs = useTradingPrefs();
  return (
    <div className="pa-tab">
      <p className="muted">
        {tl(
          'Ask before sending these actions. Lock trading (Ctrl+L / DOM lock) disables all order buttons.',
        )}
      </p>
      <div className="cf-grid">
        {CONFIRM_KINDS.map((k) => (
          <Checkbox
            key={k.id}
            checked={prefs.confirm[k.id]}
            onChange={(v) => setPrefs({ confirm: { ...prefs.confirm, [k.id]: v } })}
            label={k.label}
          />
        ))}
      </div>
      <div className="row gap8">
        <Button
          size="sm"
          onClick={() =>
            setPrefs({
              confirm: Object.fromEntries(
                CONFIRM_KINDS.map((k) => [k.id, true]),
              ) as typeof prefs.confirm,
            })
          }
        >
          {tl('Confirm everything')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setPrefs({
              confirm: Object.fromEntries(
                CONFIRM_KINDS.map((k) => [k.id, false]),
              ) as typeof prefs.confirm,
            })
          }
        >
          {tl('Confirm nothing')}
        </Button>
      </div>
    </div>
  );
}

/* ---------------- chart trading visuals ---------------- */

function ChartTab() {
  const { chart } = useTradingPrefs();
  const t = theme();
  const color = (k: keyof ChartTradingPrefs, label: string, fallback: string) => (
    <div className="atm-row">
      <span>{label}</span>
      <div className="row gap6 center-y">
        <ColorSwatch
          value={(chart[k] as string) || fallback}
          onChange={(v) => setChartPrefs({ [k]: v } as Partial<ChartTradingPrefs>)}
          label={label}
        />
        {chart[k] && (
          <button
            className="ot-link"
            onClick={() => setChartPrefs({ [k]: '' } as Partial<ChartTradingPrefs>)}
          >
            {tl('Theme default')}
          </button>
        )}
      </div>
    </div>
  );
  const check = (k: keyof ChartTradingPrefs, label: string) => (
    <Checkbox
      checked={chart[k] as boolean}
      onChange={(v) => setChartPrefs({ [k]: v } as Partial<ChartTradingPrefs>)}
      label={label}
    />
  );
  return (
    <div className="pa-tab">
      <div className="cf-grid">
        {check('enabled', 'Trading on chart (lines, drag to modify)')}
        {check('showPosition', 'Position line')}
        {check('showPnl', 'P&L on the position line')}
        {check('showOrders', 'Working order lines')}
        {check('showBrackets', 'SL / TP bracket lines')}
        {check('showFills', 'B / S fill markers')}
      </div>
      <div className="atm-form-narrow">
        {color('buyColor', 'Buy orders', t.up)}
        {color('sellColor', 'Sell orders', t.down)}
        {color('slColor', 'Stop loss', t.down)}
        {color('tpColor', 'Take profit', t.up)}
        {color('positionColor', 'Position', t.info)}
        <div className="atm-row">
          <span>{tl('Line width')}</span>
          <NumberInput
            value={chart.lineWidth}
            onChange={(v) => setChartPrefs({ lineWidth: v })}
            min={1}
            max={4}
            unit="px"
            aria-label={tl('Line width')}
          />
        </div>
        <div className="atm-row">
          <span>{tl('Line style')}</span>
          <Select
            small
            value={chart.lineStyle}
            onChange={(v) => setChartPrefs({ lineStyle: v })}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'dotted', label: 'Dotted' },
            ]}
            aria-label={tl('Line style')}
          />
        </div>
        <div className="atm-row">
          <span>{tl('Labels')}</span>
          <Select
            small
            value={chart.labelSide}
            onChange={(v) => setChartPrefs({ labelSide: v })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
            aria-label={tl('Label side')}
          />
        </div>
        <div className="atm-row">
          <span>{tl('Marker size')}</span>
          <NumberInput
            value={chart.markerSize}
            onChange={(v) => setChartPrefs({ markerSize: v })}
            min={3}
            max={16}
            unit="px"
            aria-label={tl('Marker size')}
          />
        </div>
        <div className="atm-row">
          <span>{tl('Max markers')}</span>
          <NumberInput
            value={chart.maxMarkers}
            onChange={(v) => setChartPrefs({ maxMarkers: v })}
            min={0}
            max={5000}
            step={50}
            aria-label={tl('Max markers')}
          />
        </div>
      </div>
      <Button size="sm" onClick={() => setPrefs({ chart: { ...DEFAULT_CHART_PREFS } })}>
        {tl('Reset to defaults')}
      </Button>
    </div>
  );
}

/* ---------------- window ---------------- */

function TradingSetupWindow({ state, setParams }: ModuleViewProps) {
  const stored = (state.params?.tab as SetupTab | undefined) ?? 'atm';
  const [tab, setTab] = useState<SetupTab>(TABS.some((t) => t.value === stored) ? stored : 'atm');
  const nav = useSetupNav();
  useEffect(() => {
    if (nav.tab) {
      setTab(nav.tab);
      setParams({ tab: nav.tab });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.seq]);
  return (
    <div className="module-window atm-window" data-testid="trading-setup">
      <Tabs
        tabs={TABS}
        value={tab}
        onChange={(v) => {
          setTab(v);
          setParams({ tab: v });
        }}
      />
      <div className="atm-body">
        {tab === 'atm' && <AtmEditor />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'confirm' && <ConfirmTab />}
        {tab === 'chart' && <ChartTab />}
      </div>
    </div>
  );
}

registerModule({ id: SETUP_MODULE, label: 'ATM & Trading Setup', view: TradingSetupWindow });
