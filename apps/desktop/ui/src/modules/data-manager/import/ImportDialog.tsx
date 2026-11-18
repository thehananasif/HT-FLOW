import { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Field, Input, NumberInput, Select, toast } from '@htflow/ui-kit';
import { DEFAULT_LAYERS } from '@htflow/replay';
import type { WindowState } from '@htflow/workspace';
import {
  DEFAULT_OPTIONS,
  EMPTY_MAPPING,
  autoDetect,
  convertRow,
  importCsv,
  parseCsvText,
  readSample,
  type CsvMapping,
  type CsvOptions,
  type ImportProgress,
  type ImportResult,
} from './csv';
import {
  TIME_FORMATS,
  formatTimeZone,
  parseTimeZone,
  type DateOrder,
  type TimeFormat,
} from './time';
import { addImported, type ImportedDataset } from '../../../feeds/imported';
import { startReplay } from '../../../feeds/replay';
import { useWindows } from '../../../state/windows';
import { showReplayOn } from '../../replay/ControlBar';
import { useCsvImportUi } from './ui';

import { translateLiteral as tl } from '@htflow/i18n';
const PREVIEW_ROWS = 8;
const DELIM_OPTIONS = [
  { value: ',', label: 'Comma ( , )' },
  { value: ';', label: 'Semicolon ( ; )' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe ( | )' },
];

/** Shows an imported instrument on the active (or first) chart window. */
export function showOnChart(instrumentId: string): void {
  const { activeId, windows, patch, setActive } = useWindows.getState();
  const charts = Object.entries(windows).filter(([, w]) => w.kind === 'chart');
  const first =
    (activeId && windows[activeId]?.kind === 'chart' ? activeId : null) ?? charts[0]?.[0];
  if (!first) {
    toast('info', tl('Open a chart window first'), tl('Then use Open chart again'));
    return;
  }
  patch(first, { instrumentId } as Partial<WindowState>);
  setActive(first);
}

/** Starts a replay session over the whole imported range and shows it on a chart. */
export async function replayImported(ds: ImportedDataset): Promise<void> {
  try {
    const s = await startReplay({
      instruments: [ds.id],
      from: ds.from,
      to: ds.to,
      layers: { ...DEFAULT_LAYERS, depth: false, hideFuture: true },
      source: 'csv-import',
    });
    showReplayOn([...s.engines.keys()]);
    toast('success', tl('Replay ready'), `${ds.name} · press Space on the chart to play`);
  } catch (e) {
    toast('error', tl('Replay failed'), e instanceof Error ? e.message : String(e));
  }
}

const idx = (v: string) => Number(v);
const colOptions = (headers: string[], optional: boolean) => [
  ...(optional ? [{ value: '-1', label: '(none)' }] : []),
  ...headers.map((h, i) => ({ value: String(i), label: `${i + 1}: ${h || '(blank)'}` })),
];

/** Import trades or OHLCV bars from a CSV file (Data manager → Import CSV). */
export function ImportDialog() {
  const open = useCsvImportUi((s) => s.open);
  const hide = useCsvImportUi((s) => s.hide);
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState('');
  const [name, setName] = useState('');
  const [opts, setOpts] = useState<CsvOptions>(DEFAULT_OPTIONS);
  const [map, setMap] = useState<CsvMapping>(EMPTY_MAPPING);
  const [tzText, setTzText] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [done, setDone] = useState<{ ds: ImportedDataset; result: ImportResult } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const reset = () => {
    setFile(null);
    setSample('');
    setName('');
    setOpts(DEFAULT_OPTIONS);
    setMap(EMPTY_MAPPING);
    setTzText('UTC');
    setProgress(null);
    setDone(null);
    setFatal(null);
  };
  const close = () => {
    abort.current?.abort();
    hide();
    reset();
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    reset();
    setFile(f);
    setName(f.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
    try {
      const s = await readSample(f);
      setSample(s);
      const d = autoDetect(s);
      setOpts(d.options);
      setMap(d.mapping);
    } catch (e) {
      setFatal(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const records = useMemo(
    () => (sample ? parseCsvText(sample, opts.delimiter) : []),
    [sample, opts.delimiter],
  );
  const width = Math.max(0, ...records.slice(0, 200).map((r) => r.cells.length));
  const headers = useMemo(
    () =>
      opts.hasHeader && records[0]
        ? records[0].cells.map((h) => h.trim())
        : Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
    [records, opts.hasHeader, width],
  );
  const dataRows = records.slice(opts.hasHeader ? 1 : 0, (opts.hasHeader ? 1 : 0) + PREVIEW_ROWS);
  const preview = dataRows.map((r) => ({ r, res: convertRow(r.cells, map, opts) }));
  const tz = parseTimeZone(tzText);
  const setOpt = (p: Partial<CsvOptions>) => setOpts((o) => ({ ...o, ...p }));
  const setCol = (k: keyof Omit<CsvMapping, 'kind'>, v: string) =>
    setMap((m) => ({ ...m, [k]: idx(v) }));
  const mapError =
    map.time < 0
      ? 'Choose the time column'
      : map.kind === 'trades' && (map.price < 0 || map.qty < 0)
        ? 'Choose the price and quantity columns'
        : map.kind === 'bars' && (map.open < 0 || map.high < 0 || map.low < 0 || map.close < 0)
          ? 'Choose open, high, low and close columns'
          : !tz
            ? 'Time zone must be UTC, local or an offset such as +02:00'
            : !name.trim()
              ? 'Name the dataset'
              : null;

  const run = async () => {
    if (!file || mapError) return;
    setBusy(true);
    setFatal(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const result = await importCsv(
        file,
        map,
        { ...opts, timeZone: tz ?? 'utc' },
        {
          onProgress: setProgress,
          signal: ac.signal,
        },
      );
      if (!result.rows) {
        setFatal(
          `No valid rows: ${result.errorCount.toLocaleString()} rejected. ${result.errors[0] ? `First: line ${result.errors[0].line}, ${result.errors[0].message}.` : ''}`,
        );
        setDone(null);
        setBusy(false);
        return;
      }
      const ds = addImported({
        name,
        trades: result.trades,
        tickSize: result.tickSize,
        pricePrecision: result.pricePrecision,
        qtyPrecision: result.qtyPrecision,
        source: result.kind,
      });
      setDone({ ds, result });
      toast('success', `Imported ${result.rows.toLocaleString()} rows`, ds.instrument.displayName);
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        setFatal(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const sel = (k: keyof Omit<CsvMapping, 'kind'>, label: string, optional = false) => (
    <Field label={label} key={k}>
      <Select
        aria-label={`${label} column`}
        value={String(map[k])}
        options={colOptions(headers, optional)}
        onChange={(v) => setCol(k, v)}
      />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={tl('Import CSV')}
      description={tl(
        'Trades (time, price, quantity, optional side) or OHLCV bars. The file is read in chunks and stays on this PC.',
      )}
      width={900}
    >
      <div className="dm-import">
        {!done && (
          <>
            <label className="dm-file">
              <span className="muted">{tl('CSV file')}</span>
              <input
                type="file"
                aria-label={tl('CSV file')}
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </label>
            {fatal && <div className="ht-error">{fatal}</div>}
            {file && sample && (
              <>
                <div className="dm-grid">
                  <Field label={tl('Dataset name')}>
                    <Input
                      aria-label={tl('Dataset name')}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field label={tl('Contents')}>
                    <Select
                      aria-label={tl('Contents')}
                      value={map.kind}
                      options={[
                        { value: 'trades', label: 'Trades (ticks)' },
                        { value: 'bars', label: 'OHLCV bars' },
                      ]}
                      onChange={(v) => setMap((m) => ({ ...m, kind: v }))}
                    />
                  </Field>
                  <Field label={tl('Delimiter')}>
                    <Select
                      aria-label={tl('Delimiter')}
                      value={opts.delimiter}
                      options={DELIM_OPTIONS}
                      onChange={(v) => setOpt({ delimiter: v })}
                    />
                  </Field>
                  <Checkbox
                    label={tl('First row is a header')}
                    checked={opts.hasHeader}
                    onChange={(v) => setOpt({ hasHeader: v })}
                  />
                </div>
                <div className="dm-grid">
                  {sel('time', 'Time')}
                  {map.kind === 'trades' ? (
                    <>
                      {sel('price', 'Price')}
                      {sel('qty', 'Quantity')}
                      {sel('side', 'Side', true)}
                    </>
                  ) : (
                    <>
                      {sel('open', 'Open')}
                      {sel('high', 'High')}
                      {sel('low', 'Low')}
                      {sel('close', 'Close')}
                      {sel('volume', 'Volume', true)}
                    </>
                  )}
                </div>
                <div className="dm-grid">
                  <Field label={tl('Time format')}>
                    <Select
                      aria-label={tl('Time format')}
                      value={opts.timeFormat}
                      options={TIME_FORMATS}
                      onChange={(v: TimeFormat) => setOpt({ timeFormat: v })}
                    />
                  </Field>
                  <Field
                    label={tl('Time zone of the text')}
                    hint={tz ? formatTimeZone(tz) : undefined}
                    error={tz ? undefined : 'UTC, local or +02:00'}
                  >
                    <Input
                      aria-label={tl('Time zone')}
                      value={tzText}
                      onChange={(e) => {
                        setTzText(e.target.value);
                        const z = parseTimeZone(e.target.value);
                        if (z) setOpt({ timeZone: z });
                      }}
                    />
                  </Field>
                  <Field label={tl('Date order (a/b/yyyy)')}>
                    <Select
                      aria-label={tl('Date order')}
                      value={opts.dateOrder}
                      options={[
                        { value: 'ymd', label: 'Year first / day first' },
                        { value: 'dmy', label: 'Day / month / year' },
                        { value: 'mdy', label: 'Month / day / year' },
                      ]}
                      onChange={(v: DateOrder) => setOpt({ dateOrder: v })}
                    />
                  </Field>
                  {map.kind === 'trades' ? (
                    <Field label={tl('Side values')}>
                      <Select
                        aria-label={tl('Side values')}
                        value={opts.sideMode}
                        options={[
                          { value: 'text', label: 'buy / sell, b / s, 1 / -1' },
                          { value: 'buyerMaker', label: 'is_buyer_maker (true = sell)' },
                        ]}
                        onChange={(v) => setOpt({ sideMode: v })}
                      />
                    </Field>
                  ) : (
                    <Field label={tl('Bar length (ms, 0 = detect)')}>
                      <NumberInput
                        aria-label={tl('Bar length')}
                        value={opts.barMs}
                        min={0}
                        step={1000}
                        onChange={(v) => setOpt({ barMs: v })}
                      />
                    </Field>
                  )}
                </div>
                <div className="tbl-wrap dm-preview">
                  <table className="tbl tnum">
                    <caption className="muted">
                      {tl('Preview: first')} {preview.length}{' '}
                      {tl('rows, parsed with the settings above')}
                    </caption>
                    <thead>
                      <tr>
                        <th>{tl('Line')}</th>
                        {headers.map((h, i) => (
                          <th key={i}>{h || `Column ${i + 1}`}</th>
                        ))}
                        <th>{tl('Result')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map(({ r, res }) => (
                        <tr key={r.line} data-bad={!res.ok || undefined}>
                          <td>{r.line}</td>
                          {headers.map((_, i) => (
                            <td key={i}>{r.cells[i] ?? ''}</td>
                          ))}
                          <td className={res.ok ? 'up' : 'down'}>
                            {res.ok
                              ? `${new Date(res.ts).toISOString().replace('T', ' ').replace('Z', '')} UTC`
                              : res.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {mapError && file && sample && <div className="ht-error">{mapError}</div>}
            {busy && progress && (
              <div className="muted" role="status">
                {tl('Reading…')} {(progress.bytes / 1_048_576).toFixed(1)} {tl('MB ·')}{' '}
                {progress.rows.toLocaleString()} {tl('rows ·')} {progress.errors.toLocaleString()}{' '}
                {tl('rejected')}
              </div>
            )}
            <div className="row gap8 dm-import-actions">
              <div className="grow" />
              <Button variant="ghost" onClick={close}>
                {tl('Cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!file || !sample || busy || !!mapError}
                onClick={() => void run()}
              >
                {busy ? 'Importing…' : 'Import'}
              </Button>
            </div>
          </>
        )}
        {done && (
          <>
            <div className="dm-summary" role="status">
              <b>
                {tl('Imported')} {done.result.rows.toLocaleString()} {tl('rows as')}{' '}
                {done.ds.instrument.displayName}
              </b>
              <div className="muted">
                {done.result.trades.length.toLocaleString()} {tl('trades from')}{' '}
                {new Date(done.result.from).toISOString().slice(0, 19).replace('T', ' ')} {tl('to')}{' '}
                {new Date(done.result.to).toISOString().slice(0, 19).replace('T', ' ')}{' '}
                {tl('UTC · tick size')} {done.result.tickSize}
                {done.result.sorted ? ' · rows were out of order and have been sorted' : ''}
                {done.result.sideDerived ? ' · side derived with the tick rule' : ''}
                {done.result.kind === 'bars'
                  ? ` · 4 synthetic trades per bar (open, extremes, close) over ${done.result.barMs / 1000}s bars`
                  : ''}
              </div>
            </div>
            {done.result.errorCount > 0 && (
              <div className="dm-errors">
                <div className="ht-error">
                  {done.result.errorCount.toLocaleString()} {tl('rows rejected')}
                  {done.result.errorCount > done.result.errors.length
                    ? ` (first ${done.result.errors.length} listed)`
                    : ''}
                </div>
                <ul>
                  {done.result.errors.map((e) => (
                    <li key={e.line}>
                      {tl('Line')} {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="row gap8 dm-import-actions">
              <div className="grow" />
              <Button variant="ghost" onClick={close}>
                {tl('Close')}
              </Button>
              <Button variant="outline" onClick={() => showOnChart(done.ds.id)}>
                {tl('Open chart')}
              </Button>
              <Button variant="primary" onClick={() => void replayImported(done.ds)}>
                {tl('Open in Replay')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
