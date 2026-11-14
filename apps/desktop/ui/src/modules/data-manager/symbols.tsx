import { Button } from '@htflow/ui-kit';
import { isTauri } from '../../backend';
import { runCommand } from '../../shell/commands';
import { discoverySummary, useDiscovery } from '../../state/discovery';

function ago(ms: number): string {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Data manager: per-venue symbol counts of the live symbol discovery, last refresh, errors. */
export function SymbolLists() {
  const { report, loading, error } = useDiscovery();
  const rows = discoverySummary(report);
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <section className="col gap8" data-testid="symbol-lists">
      <div className="row gap12" style={{ alignItems: 'center' }}>
        <strong>Symbol lists</strong>
        <span className="muted" data-testid="symbol-lists-total">
          {rows.length
            ? `${total.toLocaleString()} symbols · refreshed ${ago(report?.refreshedAtMs ?? 0)}`
            : isTauri
              ? 'Loading every venue’s symbol list…'
              : 'Browser preview: built-in list (exchange APIs block browser requests)'}
        </span>
        <Button
          size="sm"
          disabled={loading}
          onClick={() => runCommand('instruments.refreshSymbols')}
        >
          {loading ? 'Refreshing…' : 'Refresh symbol list'}
        </Button>
      </div>
      {error && <div className="muted">Last refresh failed: {error}</div>}
      {rows.length > 0 && (
        <table className="tbl tnum dm-table">
          <thead>
            <tr>
              <th>Venue</th>
              <th>Symbols</th>
              <th>Updated</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`symbols-${r.id}`}>
                <td>{r.label}</td>
                <td>
                  {r.count.toLocaleString()}
                  {r.optionsCount ? ` (+${r.optionsCount.toLocaleString()} options)` : ''}
                </td>
                <td>{ago(r.fetchedAtMs)}</td>
                <td title={r.error}>{r.ok ? 'OK' : `Kept last list: ${r.error ?? 'failed'}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
