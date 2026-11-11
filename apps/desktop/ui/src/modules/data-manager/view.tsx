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
import './styles.css';

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
      <EmptyState title="Data manager runs in the desktop app">
        Recorded ticks and depth live in the local tick store on your PC (%APPDATA%\HTFlow\ticks).
        The browser preview has no tick store — open HT Flow for Windows to record, browse, export
        and delete history.
      </EmptyState>
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
      toast('success', 'Recorder settings saved');
    } catch (e) {
      toast('error', 'Could not save', String((e as Error).message));
    }
  };
  const del = async (inst: string, day?: string) => {
    const what = day ? `${inst} on ${day}` : `all data of ${inst}`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      const r = await dataApi.remove(inst, day, day);
      toast('success', `Deleted ${r.filesDeleted} files`, `${formatBytes(r.bytesFreed)} freed`);
      void refresh();
    } catch (e) {
      toast('error', 'Delete failed', String((e as Error).message));
    }
  };
  const exp = async (inst: string, kind: 'trades' | 'depth', day?: string) => {
    try {
      const r = await dataApi.exportCsv(inst, kind, day, day);
      toast('success', `Exported ${r.rows.toLocaleString()} rows`, r.path, 8000);
    } catch (e) {
      toast('error', 'Export failed', String((e as Error).message));
    }
  };

  return (
    <div className="col fill pad12 gap12 dm-root">
      <div className="row gap12 dm-rec">
        <Checkbox
          label="Record live ticks + depth of subscribed instruments"
          checked={status?.settings.enabled ?? true}
          onChange={(v) => void setRecorder(v)}
        />
        <label className="row gap8">
          <span className="muted">Keep days</span>
          <NumberInput
            aria-label="Retention days"
            value={limits.retentionDays}
            min={0}
            max={3650}
            onChange={(v) => setLimits({ ...limits, retentionDays: v })}
          />
        </label>
        <label className="row gap8">
          <span className="muted">Max disk</span>
          <NumberInput
            aria-label="Max disk GB"
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
          Apply
        </Button>
        <div className="grow" />
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {limitErr && <div className="ht-error">{limitErr}</div>}
      {error && <div className="ht-error">{error}</div>}
      <div className="row gap8">
        <div className="card-stat">
          <span className="muted">Instruments stored</span>
          <b>{list?.length ?? '—'}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Size on disk</span>
          <b className="tnum">{status ? formatBytes(status.diskBytes) : '—'}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Recording now</span>
          <b>{status?.recording.length ?? 0}</b>
        </div>
        <div className="card-stat">
          <span className="muted">Dropped / errors</span>
          <b className="tnum">{status ? `${status.dropped} / ${status.errors}` : '—'}</b>
        </div>
      </div>
      <div className="tbl-wrap">
        <table className="tbl tnum dm-table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>From</th>
              <th>To (UTC)</th>
              <th className="r">Days</th>
              <th className="r">Trades</th>
              <th className="r">Depth rows</th>
              <th className="r">Size</th>
              <th className="r">Actions</th>
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
                <td className="r dm-actions">
                  <button
                    type="button"
                    className="cx-link"
                    onClick={() => void exp(i.instrument, 'trades')}
                  >
                    Export trades CSV
                  </button>
                  <button
                    type="button"
                    className="cx-link"
                    onClick={() => void exp(i.instrument, 'depth')}
                  >
                    Depth CSV
                  </button>
                  <button
                    type="button"
                    className="cx-link down"
                    onClick={() => void del(i.instrument)}
                  >
                    Delete
                  </button>
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
                      <td className="r dm-actions">
                        <button
                          type="button"
                          className="cx-link"
                          onClick={() => void exp(i.instrument, 'trades', d.date)}
                        >
                          CSV
                        </button>
                        <button
                          type="button"
                          className="cx-link down"
                          onClick={() => void del(i.instrument, d.date)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                : []),
            ])}
          </tbody>
        </table>
        {list && !list.length && (
          <div className="tbl-empty">
            Nothing recorded yet — open a live chart (Binance Futures, Bybit) and the recorder
            stores its ticks and depth here.
          </div>
        )}
      </div>
      {status && <div className="muted dm-root-path mono">{status.root}</div>}
    </div>
  );
}
