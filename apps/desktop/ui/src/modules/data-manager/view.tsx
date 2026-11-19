import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, EmptyState, NumberInput, toast } from '@htflow/ui-kit';
import { isTauri } from '../../backend';
import {
  dataApi,
  formatBytes,
  validateLimits,
  type InstrumentSummary,
  type RecorderStatus,
} from './api';
import { ImportedFiles } from './import/ImportedList';
import { SymbolLists } from './symbols';
import './styles.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
const fmtDate = (ms: number) =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';

/** P06 Data manager: instruments stored, date ranges, size on disk, delete, export CSV. */
export function DataManager() {
  const [list, setList] = useState<InstrumentSummary[] | null>(null);
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [limits, setLimits] = useState({ retentionDays: 30, maxDiskGb: 20 });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([dataApi.list(), dataApi.status()]);
      setList(l);
      setStatus(s);
      setLimits({ retentionDays: s.settings.retentionDays, maxDiskGb: s.settings.maxDiskGb });
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    if (isTauri) void refresh();
  }, [refresh]);

  if (!isTauri) {
    return (
      <div className="col fill pad12 gap12 dm-root">
        <SymbolLists />
        <ImportedFiles />
        <EmptyState title={tl('Data manager runs in the desktop app')}>
          {tl(
            'Recorded ticks and depth live in the local tick store on your PC (%APPDATA%\\HTFlow\\ticks). The browser preview has no tick store — open HT Flow for Windows to record, browse, export and delete history.',
          )}
        </EmptyState>
      </div>
    );
  }

  const limitErr = validateLimits(limits.retentionDays, limits.maxDiskGb);
  const setRecorder = async (enabled: boolean) => {
    if (limitErr) return;
    try {
      setStatus(
        await dataApi.setRecorder(
          enabled,
          status?.settings.instruments ?? null,
          limits.retentionDays,
          limits.maxDiskGb,
        ),
      );
      toast('success', tl('Recorder settings saved'));
    } catch (e) {
      toast('error', tl('Could not save'), String((e as Error).message));
    }
  };
  const del = async (inst: string, day?: string) => {
    const what = day ? `${inst} on ${day}` : `all data of ${inst}`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      const r = await dataApi.remove(inst, day, day);
      toast('success', tt`Deleted ${r.filesDeleted} files`, tt`${formatBytes(r.bytesFreed)} freed`);
      void refresh();
    } catch (e) {
      toast('error', tl('Delete failed'), String((e as Error).message));
    }
  };
  const exp = async (inst: string, kind: 'trades' | 'depth', day?: string) => {
    try {
      const r = await dataApi.exportCsv(inst, kind, day, day);
      toast('success', tt`Exported ${r.rows.toLocaleString()} rows`, r.path, 8000);
    } catch (e) {
      toast('error', tl('Export failed'), String((e as Error).message));
    }
  };

  return (
    <div className="col fill pad12 gap12 dm-root">
      <SymbolLists />
      <div className="row gap12 dm-rec">
        <Checkbox
          label={tl('Record live ticks + depth of subscribed instruments')}
          checked={status?.settings.enabled ?? true}
          onChange={(v) => void setRecorder(v)}
        />
        <label className="row gap8">
          <span className="muted">{tl('Keep days')}</span>
          <NumberInput
            aria-label={tl('Retention days')}
            value={limits.retentionDays}
            min={0}
            max={3650}
            onChange={(v) => setLimits({ ...limits, retentionDays: v })}
          />
        </label>
        <label className="row gap8">
          <span className="muted">{tl('Max disk')}</span>
          <NumberInput
            aria-label={tl('Max disk GB')}
            value={limits.maxDiskGb}
            min={0}
            max={10_000}
            step={1}
            unit="GB"
            onChange={(v) => setLimits({ ...limits, maxDiskGb: v })}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!!limitErr}
          onClick={() => void setRecorder(status?.settings.enabled ?? true)}
        >
          {tl('Apply')}
        </Button>
        <div className="grow" />
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          {tl('Refresh')}
        </Button>
      </div>
      <ImportedFiles />
      {limitErr && <div className="ht-error">{limitErr}</div>}
      {error && <div className="ht-error">{error}</div>}
      <div className="row gap8">
        <div className="card-stat">
          <span className="muted">{tl('Instruments stored')}</span>
          <b>{list?.length ?? '—'}</b>
        </div>
        <div className="card-stat">
          <span className="muted">{tl('Size on disk')}</span>
          <b className="tnum">{status ? formatBytes(status.diskBytes) : '—'}</b>
        </div>
        <div className="card-stat">
          <span className="muted">{tl('Recording now')}</span>
          <b>{status?.recording.length ?? 0}</b>
        </div>
        <div className="card-stat">
          <span className="muted">{tl('Dropped / errors')}</span>
          <b className="tnum">{status ? `${status.dropped} / ${status.errors}` : '—'}</b>
        </div>
      </div>
      <div className="tbl-wrap">
        <table className="tbl tnum dm-table">
          <thead>
            <tr>
              <th>{tl('Instrument')}</th>
              <th>{tl('From')}</th>
              <th>{tl('To (UTC)')}</th>
              <th className="r">{tl('Days')}</th>
              <th className="r">{tl('Trades')}</th>
              <th className="r">{tl('Depth rows')}</th>
              <th className="r">{tl('Size')}</th>
              <th className="r">{tl('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(list ?? []).flatMap((i) => [
              <tr key={i.instrument} className="dm-inst">
                <td>
                  <button
                    type="button"
                    className="cx-link"
                    aria-expanded={open === i.instrument}
                    onClick={() => setOpen(open === i.instrument ? null : i.instrument)}
                  >
                    {open === i.instrument ? '▾' : '▸'}
                  </button>{' '}
                  <span className="mono">{i.instrument}</span>
                </td>
                <td>{fmtDate(i.firstMs)}</td>
                <td>{fmtDate(i.lastMs)}</td>
                <td className="r">{i.days.length}</td>
                <td className="r">{i.trades.toLocaleString()}</td>
                <td className="r">{i.depthRecords.toLocaleString()}</td>
                <td className="r">{formatBytes(i.bytes)}</td>
                <td className="r">
                  <div className="dm-actions">
                    <button
                      type="button"
                      className="cx-link"
                      onClick={() => void exp(i.instrument, 'trades')}
                    >
                      {tl('Export trades CSV')}
                    </button>
                    <button
                      type="button"
                      className="cx-link"
                      onClick={() => void exp(i.instrument, 'depth')}
                    >
                      {tl('Depth CSV')}
                    </button>
                    <button
                      type="button"
                      className="cx-link down"
                      onClick={() => void del(i.instrument)}
                    >
                      {tl('Delete')}
                    </button>
                  </div>
                </td>
              </tr>,
              ...(open === i.instrument
                ? i.days.map((d) => (
                    <tr key={i.instrument + d.date} className="dm-day">
                      <td className="dm-indent">{d.date}</td>
                      <td>{fmtDate(d.firstMs)}</td>
                      <td>{fmtDate(d.lastMs)}</td>
                      <td />
                      <td className="r">{d.trades.toLocaleString()}</td>
                      <td className="r">{d.depthRecords.toLocaleString()}</td>
                      <td className="r">{formatBytes(d.tradeBytes + d.depthBytes)}</td>
                      <td className="r">
                        <div className="dm-actions">
                          <button
                            type="button"
                            className="cx-link"
                            onClick={() => void exp(i.instrument, 'trades', d.date)}
                          >
                            {tl('CSV')}
                          </button>
                          <button
                            type="button"
                            className="cx-link down"
                            onClick={() => void del(i.instrument, d.date)}
                          >
                            {tl('Delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                : []),
            ])}
          </tbody>
        </table>
        {list && !list.length && (
          <div className="tbl-empty">
            {tl(
              'Nothing recorded yet — open a live chart (Binance Futures, Bybit) and the recorder stores its ticks and depth here.',
            )}
          </div>
        )}
      </div>
      {status && <div className="muted dm-root-path mono">{status.root}</div>}
    </div>
  );
}
