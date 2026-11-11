import type { ReactNode } from 'react';

/** Minimal table used by module windows (virtualised DataTable arrives with P20). */
export function SimpleTable({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  return (
    <div className="tbl-wrap">
      <table className="tbl tnum">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, k) => (
                <td key={k}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="tbl-empty">{empty}</div>}
    </div>
  );
}
