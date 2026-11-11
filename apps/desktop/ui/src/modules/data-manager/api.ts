import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../backend';

/** Tick store IPC (crates/tick-store via src-tauri/data_cmds.rs). Desktop app only. */

export interface DaySummary {
  date: string;
  day: number;
  tradeBytes: number;
  depthBytes: number;
  trades: number;
  depthRecords: number;
  firstMs: number;
  lastMs: number;
}

export interface InstrumentSummary {
  instrument: string;
  venue: string;
  symbol: string;
  days: DaySummary[];
  bytes: number;
  trades: number;
  depthRecords: number;
  firstMs: number;
  lastMs: number;
}

export interface RecorderSettings {
  enabled: boolean;
  instruments: string[] | null;
  retentionDays: number;
  maxDiskGb: number;
}

export interface RecorderStatus {
  settings: RecorderSettings;
  recording: string[];
  diskBytes: number;
  trades: number;
  depthRows: number;
  errors: number;
  dropped: number;
  root: string;
}

export interface WireReplay {
  tick_size: number;
  price_precision: number;
  trades: [number, number, number, number, number][];
  snapshots: [number, [number, number][], [number, number][]][];
}

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('The tick store is part of the desktop app');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(errText(e));
  }
}

export const dataApi = {
  list: () => call<InstrumentSummary[]>('data_list'),
  remove: (instrument: string, from?: string, to?: string) =>
    call<{ filesDeleted: number; bytesFreed: number }>('data_delete', { instrument, from, to }),
  exportCsv: (instrument: string, kind: 'trades' | 'depth', from?: string, to?: string) =>
    call<{ path: string; rows: number }>('data_export_csv', { instrument, kind, from, to }),
  replay: (instrument: string, fromMs: number, toMs: number, depth: boolean) =>
    call<WireReplay>('data_replay', { instrument, fromMs, toMs, depth }),
  status: () => call<RecorderStatus>('recorder_status'),
  setRecorder: (
    enabled: boolean,
    instruments: string[] | null,
    retentionDays?: number,
    maxDiskGb?: number,
  ) => call<RecorderStatus>('recorder_set', { enabled, instruments, retentionDays, maxDiskGb }),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Validates the recorder limits form: retention 0–3650 days (0 = forever), disk 0–10000 GB. */
export function validateLimits(retentionDays: number, maxDiskGb: number): string | null {
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)
    return 'Retention must be 0–3650 days (0 keeps everything)';
  if (!Number.isFinite(maxDiskGb) || maxDiskGb < 0 || maxDiskGb > 10_000)
    return 'Max disk must be 0–10000 GB (0 = unlimited)';
  return null;
}
