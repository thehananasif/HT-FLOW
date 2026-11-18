/** Editors and panels of the later Settings pages: data providers, custom modules, About, Logs. */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, toast, type ColumnLayout } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { feedProviders } from '../../feeds/registry';
import { moduleDef } from '../../shell/modules';
import { registeredModules } from '../registry';
import { ALWAYS_ON_MODULES } from '../../state/modules';
import {
  LOG_LEVELS,
  clearLog,
  levelEnabled,
  logText,
  useLogStore,
  type LogLevel,
} from '../../state/log';
import { fmtDateTime } from '../../state/format';
import { ABOUT_LINKS, BUNDLED_LIBRARIES } from './licenses';
import { useReportDialog } from '../../platform/crash';
import { checkForUpdates } from '../../platform/updates';
import type { EditorProps } from './editors';
import { calendar } from '../calendar/store';
import { DEFAULT_FEEDS } from '../rss/store';
import { openUrl, useStore } from '../rss/shared';
import { nativeAvailable, nativeFeedAllowList } from '../rss/native';

// ------------------------------------------------------------------ news data sources

const CALENDAR_PAGE = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** Read-only list of the public hosts News / RSS / Calendar may contact, with a calendar toggle. */
export function DataSourcesEditor() {
  const cal = useStore(calendar);
  const [custom, setCustom] = useState<string[]>([]);
  useEffect(() => {
    if (nativeAvailable())
      void nativeFeedAllowList().then(
        (l) => setCustom(l.custom),
        () => {},
      );
  }, []);
  return (
    <div data-testid="data-sources">
      <table className="tbl">
        <thead>
          <tr>
            <th>Source</th>
            <th>Host</th>
            <th>Used for</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <label className="row gap6 center-y">
                <input
                  type="checkbox"
                  checked={cal.publicOn}
                  onChange={(e) => calendar.set({ ...calendar.get(), publicOn: e.target.checked })}
                  aria-label="Fetch the public economic calendar"
                />
                Public economic calendar
              </label>
            </td>
            <td>
              <button className="link" onClick={() => openUrl(CALENDAR_PAGE)}>
                nfs.faireconomy.media
              </button>
            </td>
            <td>Calendar window, chart event markers, calendar alerts, news-flatten rule</td>
            <td>
              {!cal.publicOn
                ? 'Off'
                : cal.pub.error
                  ? `Offline: ${cal.pub.error}`
                  : cal.pub.fetchedAt
                    ? `${cal.pub.events.length} events`
                    : 'Not fetched yet'}
            </td>
          </tr>
          {DEFAULT_FEEDS.map((f) => (
            <tr key={f.id}>
              <td>{f.title}</td>
              <td>
                <button className="link" onClick={() => openUrl(f.url)}>
                  {new URL(f.url).hostname}
                </button>
              </td>
              <td>RSS Reader and News ({f.folder})</td>
              <td>Default feed</td>
            </tr>
          ))}
          {custom.map((h) => (
            <tr key={h}>
              <td>Your feed host</td>
              <td>{h}</td>
              <td>RSS Reader and News</td>
              <td>Added by you</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        All requests are made by the HT Flow core over https, without cookies or keys; feeds you add
        in the RSS Reader are allowed after URL validation. Add or remove feeds in the RSS Reader.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ data provider priority

const PROVIDER_LABELS: Record<string, string> = {
  'binance-futures': 'Binance USD-M futures (live)',
  'bybit-linear': 'Bybit linear (live)',
  replay: 'Replay (recorded data)',
  mock: 'Simulator (mock feed)',
};

export function ProvidersEditor({ value, onChange }: EditorProps<string[]>) {
  const registered = feedProviders().map((p) => p.prefix.replace(/:$/, ''));
  const list = [...value, ...registered.filter((r) => !value.includes(r))];
  const label = (id: string) =>
    PROVIDER_LABELS[id] ??
    feedProviders().find((p) => p.prefix.replace(/:$/, '') === id)?.label ??
    id;
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <table className="tbl" data-testid="provider-priority">
      <thead>
        <tr>
          <th>#</th>
          <th>Provider</th>
          <th>Id</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.map((id, i) => (
          <tr key={id}>
            <td className="tnum">{i + 1}</td>
            <td>{label(id)}</td>
            <td className="muted">{id}</td>
            <td className="st-actions">
              <button
                className="ht-icon-btn"
                aria-label={`Raise ${label(id)}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                className="ht-icon-btn"
                aria-label={`Lower ${label(id)}`}
                disabled={i === list.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={12} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ custom modules (P43)

export function ModuleTogglesEditor({ value, onChange }: EditorProps<string[]>) {
  const mods = registeredModules()
    .map((r) => ({
      id: r.id,
      name: r.label ?? moduleDef(r.id)?.label ?? r.id,
      group: moduleDef(r.id)?.group ?? 'Module',
      phase: moduleDef(r.id)?.phase ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const connectors = feedProviders();
  return (
    <div className="st-modules">
      <table className="tbl" data-testid="module-list">
        <thead>
          <tr>
            <th>Enabled</th>
            <th>Module</th>
            <th>Kind</th>
            <th>Version</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {mods.map((m) => {
            const locked = ALWAYS_ON_MODULES.includes(m.id);
            const enabled = locked || !value.includes(m.id);
            return (
              <tr key={m.id} data-testid={`module-${m.id}`}>
                <td>
                  <input
                    type="checkbox"
                    className="st-check"
                    aria-label={`Enable ${m.name}`}
                    checked={enabled}
                    disabled={locked}
                    title={locked ? 'The Settings window cannot be disabled' : undefined}
                    onChange={(e) =>
                      onChange(
                        e.target.checked ? value.filter((x) => x !== m.id) : [...value, m.id],
                      )
                    }
                  />
                </td>
                <td>{m.name}</td>
                <td className="muted">Panel · {m.group}</td>
                <td className="tnum muted">built-in</td>
                <td className="muted">HT Flow {m.phase && `(${m.phase})`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="st-sub-head">Connectors</div>
      <table className="tbl" data-testid="connector-list">
        <thead>
          <tr>
            <th>Connector</th>
            <th>Id prefix</th>
            <th>Runs in</th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((p) => (
            <tr key={p.prefix}>
              <td>{p.label}</td>
              <td className="muted">{p.prefix}</td>
              <td className="muted">{p.desktopOnly ? 'Windows app' : 'App and browser preview'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted st-note">
        Installed indicators and strategies appear here once the module SDK loads packages from
        module folders. Removing a module means deleting its folder.
      </p>
    </div>
  );
}

export function ModuleFoldersEditor({ value, onChange }: EditorProps<string[]>) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const add = () => {
    const p = path.trim();
    if (!p) return setError('Enter a folder path');
    if (/[<>"|?*\0]/.test(p) || p.length > 260) return setError('Not a valid folder path');
    if (value.includes(p)) return setError('This folder is already in the list');
    if (value.length >= 20) return setError('At most 20 folders');
    setError('');
    setPath('');
    onChange([...value, p]);
  };
  return (
    <div className="st-folders" data-testid="module-folders">
      <div className="row gap8 center-y">
        <input
          className="ht-input st-text"
          aria-label="Module folder path"
          placeholder="C:\HTFlow\modules"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button size="sm" onClick={add}>
          <Plus size={13} /> Add module folder
        </Button>
      </div>
      {error && <span className="ht-error st-err">{error}</span>}
      {value.length === 0 ? (
        <p className="muted st-note">No extra folders. The built-in modules always load.</p>
      ) : (
        <ul className="st-folder-list">
          {value.map((f) => (
            <li key={f}>
              <span className="grow">{f}</span>
              <button
                className="ht-icon-btn"
                aria-label={`Remove ${f}`}
                onClick={() => onChange(value.filter((x) => x !== f))}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted st-note">
        Placeholder: folders are stored with your profile. Loading code from them (sandboxed, with
        permissions) needs the native core and is not built yet.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ About

export function AboutPanel() {
  const [version, setVersion] = useState('…');
  useEffect(() => {
    let live = true;
    void backend
      .appVersion()
      .then((v) => live && setVersion(v))
      .catch(() => live && setVersion('unknown'));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="st-about" data-testid="about-panel">
      <div className="st-about-head">
        <b>HT Flow</b>
        <Badge kind="default">v{version}</Badge>
        <span className="muted">Order-flow trading platform · local-first · MIT licence</span>
      </div>
      <div className="st-about-links">
        {ABOUT_LINKS.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
            {l.label}
          </a>
        ))}
      </div>
      <div className="row gap8">
        <Button size="sm" onClick={() => void checkForUpdates()} data-testid="about-check-updates">
          Check for updates
        </Button>
        <Button size="sm" onClick={() => useReportDialog.getState().show()}>
          Report a problem…
        </Button>
      </div>
      <div className="st-sub-head">Open-source libraries bundled with HT Flow</div>
      <table className="tbl" data-testid="licence-table">
        <thead>
          <tr>
            <th>Library</th>
            <th>Licence</th>
            <th>Part</th>
            <th>Homepage</th>
          </tr>
        </thead>
        <tbody>
          {BUNDLED_LIBRARIES.map((l) => (
            <tr key={l.name}>
              <td>{l.name}</td>
              <td>{l.license}</td>
              <td className="muted">{l.part}</td>
              <td>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.url.replace('https://github.com/', '')}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ Logs

export function LogPanel({ level }: { level: LogLevel }) {
  const entries = useLogStore((s) => s.entries);
  const [filter, setFilter] = useState<LogLevel>('debug');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = entries
    .filter(
      (e) =>
        levelEnabled(e.level, filter) &&
        (!q || `${e.source} ${e.message}`.toLowerCase().includes(q)),
    )
    .slice(-200)
    .reverse();
  return (
    <div className="st-log" data-testid="log-panel">
      <div className="row gap8 center-y">
        <select
          className="ht-select ht-select--sm"
          aria-label="Show log level"
          value={filter}
          onChange={(e) => setFilter(e.target.value as LogLevel)}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'debug' ? 'All levels' : `Up to ${l}`}
            </option>
          ))}
        </select>
        <input
          className="ht-input st-text"
          aria-label="Search log"
          placeholder="Search the log…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="grow" />
        <span className="muted">
          {entries.length} entries · recording {level}
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(logText(shown.slice().reverse()));
            toast('success', 'Log copied', `${shown.length} entries`);
          }}
        >
          <Copy size={12} /> Copy
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
            a.download = `htflow-log-${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          <Download size={12} /> Export
        </Button>
        <Button size="xs" variant="outline" onClick={clearLog}>
          <Trash2 size={12} /> Clear
        </Button>
      </div>
      <div className="st-log-rows">
        {shown.length === 0 ? (
          <div className="tbl-empty">No log entries at this level</div>
        ) : (
          shown.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="st-log-row" data-level={e.level}>
              <span className="muted tnum">{fmtDateTime(e.ts, { ms: true })}</span>
              <span className="st-log-level">{e.level}</span>
              <span className="muted">{e.source}</span>
              <span className="st-log-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ table column layouts

export function TableLayoutsEditor({ value, onChange }: EditorProps<Record<string, ColumnLayout>>) {
  const ids = Object.keys(value).sort();
  return (
    <div className="st-folders" data-testid="table-layouts">
      {ids.length === 0 ? (
        <p className="muted st-note">
          No saved layouts. Drag a table header edge to resize a column, or drag a header to
          reorder.
        </p>
      ) : (
        <ul className="st-folder-list">
          {ids.map((id) => (
            <li key={id}>
              <span className="grow">
                {id} · {value[id]!.order.length} ordered · {Object.keys(value[id]!.widths).length}{' '}
                resized
              </span>
              <button
                className="ht-icon-btn"
                aria-label={`Reset layout of ${id}`}
                onClick={() => {
                  const next = { ...value };
                  delete next[id];
                  onChange(next);
                }}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {ids.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => onChange({})}>
          Reset all table layouts
        </Button>
      )}
    </div>
  );
}
