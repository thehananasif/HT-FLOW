import { useEffect, useState } from 'react';
import { DataTable, Pill, tableParams, type DataColumn } from '../../components/DataTable';
import { registerModule, type ModuleViewProps } from '../registry';
import { fmtClock, fmtDate, useTimeFormat } from '../../state/format';
import { activityLog, type ActivityEvent, type ActivityType } from './log';

const TYPES: Record<
  ActivityType,
  { label: string; tone: 'up' | 'down' | 'warning' | 'info' | 'muted' }
> = {
  fill: { label: 'Fill', tone: 'up' },
  bracket: { label: 'Bracket', tone: 'info' },
  cancel: { label: 'Cancel', tone: 'muted' },
  reject: { label: 'Rejected', tone: 'down' },
  risk: { label: 'Risk', tone: 'warning' },
  lock: { label: 'Lock', tone: 'down' },
  connection: { label: 'Error', tone: 'down' },
  alert: { label: 'Alert', tone: 'warning' },
  info: { label: 'Info', tone: 'muted' },
};

const stamp = (ts: number) => {
  const t = fmtClock(ts);
  return fmtDate(ts) === fmtDate(Date.now()) ? t : `${fmtDate(ts)} ${t}`;
};

const cols: DataColumn<ActivityEvent>[] = [
  {
    id: 'time',
    header: 'Time',
    width: 0.9,
    value: (e) => e.ts,
    render: (e) => <span className="muted">{stamp(e.ts)}</span>,
  },
  {
    id: 'account',
    header: 'Account',
    width: 1.1,
    value: (e) => e.account,
    render: (e) => <span className="muted">{e.account}</span>,
  },
  {
    id: 'event',
    header: 'Event',
    width: 0.8,
    value: (e) => TYPES[e.type]?.label ?? e.type,
    render: (e) => (
      <Pill tone={TYPES[e.type]?.tone ?? 'muted'}>{TYPES[e.type]?.label ?? e.type}</Pill>
    ),
  },
  { id: 'details', header: 'Details', width: 3.4, value: (e) => e.message },
];

function Activity({ state, setParams }: ModuleViewProps) {
  useTimeFormat();
  const [, set] = useState(0);
  useEffect(() => activityLog.subscribe(() => set((x) => x + 1)), []);
  const rows = [...activityLog.list()].reverse();
  return (
    <div className="module-window">
      <DataTable
        testId="activity-table"
        title="Trading Activity"
        subtitle="all account events"
        rows={rows}
        columns={cols}
        rowKey={(e) => e.id}
        empty="No activity yet"
        exportName="htflow-activity"
        footer={<span>Kept 90 days · ☰ → Column filters to filter by event · Export CSV</span>}
        {...tableParams(state.params, setParams, cols)}
      />
    </div>
  );
}

registerModule({ id: 'activity', view: Activity });
