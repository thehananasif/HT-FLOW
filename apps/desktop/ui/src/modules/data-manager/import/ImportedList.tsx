import { useEffect, useState } from 'react';
import { Button } from '@htflow/ui-kit';
import { listImported, onImportedChange, removeImported } from '../../../feeds/imported';
import { ImportDialog, replayImported, showOnChart } from './ImportDialog';
import { openCsvImport } from './ui';

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** "Imported files" block of the Data manager: import button, dialog and the imported datasets. */
export function ImportedFiles() {
  const [, bump] = useState(0);
  useEffect(() => onImportedChange(() => bump((x) => x + 1)), []);
  const list = listImported();
  return (
    <div className="col gap8 dm-imported">
      <div className="row gap8">
        <Button size="sm" variant="primary" onClick={openCsvImport}>
          Import CSV…
        </Button>
        <span className="muted">
          Trades or OHLCV bars from a file; they open in a chart and in Replay.
        </span>
      </div>
      {list.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl tnum dm-table" aria-label="Imported files">
            <thead>
              <tr>
                <th>Imported dataset</th>
                <th>From (UTC)</th>
                <th>To (UTC)</th>
                <th className="r">Trades</th>
                <th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.id}</td>
                  <td>{fmt(d.from)}</td>
                  <td>{fmt(d.to)}</td>
                  <td className="r">{d.trades.length.toLocaleString()}</td>
                  <td className="r">
                    <div className="dm-actions">
                      <button type="button" className="cx-link" onClick={() => showOnChart(d.id)}>
                        Chart
                      </button>
                      <button
                        type="button"
                        className="cx-link"
                        onClick={() => void replayImported(d)}
                      >
                        Replay
                      </button>
                      <button
                        type="button"
                        className="cx-link down"
                        aria-label={`Remove ${d.id}`}
                        onClick={() => removeImported(d.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ImportDialog />
    </div>
  );
}
