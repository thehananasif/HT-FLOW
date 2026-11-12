/**
 * Workspaces window (P25 / P37 #1 and #2): saved workspaces as a grid with live layout thumbnails,
 * favourites, recent list and starters; Save current / Save as / Import / Export; the "Manage
 * workspace" tree with its summary; and the link-group manager.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, MoreHorizontal, Save, Star, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  Chip,
  Combobox,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  SplitPane,
  Table,
  Tabs,
  TreeView,
  type TableColumn,
} from '@htflow/ui-kit';
import {
  filterWorkspaces,
  LINK_COLOR_IDS,
  LINK_COLORS,
  linkGroups,
  sortWorkspaces,
  STARTER_WORKSPACES,
  tabTiles,
  validateName,
  windowLink,
  windowTitle,
  type LinkColor,
  type LinkGroupInfo,
  type StoredWorkspace,
  type ThumbTile,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceSort,
} from '@htflow/workspace';
import { useWindows } from '../../state/windows';
import { allInstruments, instrumentById } from '../../state/instruments';
import { isTauri } from '../../backend';
import { fmtClock, fmtDateTime, useTimeFormat } from '../../state/format';
import { useSetting } from '../../state/settings';
import { askConfirm } from '../../state/confirm';
import { moduleDef } from '../../shell/modules';
import type { ModuleViewProps } from '../registry';
import { workspaceHost } from './host';
import {
  addStarter,
  deleteWorkspace,
  duplicateWorkspace,
  ensureLibrary,
  exportWorkspace,
  loadWorkspace,
  pickWorkspaceFile,
  renameWorkspace,
  replaceSavedDoc,
  saveAs,
  saveCurrent,
  setDescription,
  toggleFavourite,
  useWorkspaces,
} from './store';
import { takePendingAction, type WorkspacesAction } from './menu';
import { formatBytes, manageTree, removeWindowFromDoc, summarize } from './model';
import { setLink } from './windowActions';

type Pane = 'library' | 'manage' | 'links';

export function windowLabel(s: WindowState): string {
  if (s.kind === 'module') return moduleDef(s.module)?.label ?? s.module;
  return windowTitle(s, instrumentById(s.instrumentId)?.symbol ?? s.instrumentId);
}

// ------------------------------------------------------------------ thumbnail

export function Thumbnail({ tiles, label }: { tiles: ThumbTile[]; label: string }) {
  return (
    <div className="wsm-thumb" role="img" aria-label={`Layout of ${label}`}>
      {tiles.map((t) => (
        <span
          key={t.id}
          className={`wsm-tile wsm-tile--${t.kind}${t.floating ? ' wsm-tile--float' : ''}`}
          style={{
            left: `${t.x * 100}%`,
            top: `${t.y * 100}%`,
            width: `${t.w * 100}%`,
            height: `${t.h * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ name dialog

function NameDialog({
  open,
  title,
  initialName,
  initialDescription,
  exceptId,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initialName: string;
  initialDescription: string;
  exceptId?: string;
  confirmLabel: string;
  onClose(): void;
  onSubmit(name: string, description: string): void;
}) {
  const lib = useWorkspaces((s) => s.lib);
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState(initialDescription);
  useEffect(() => {
    if (open) {
      setName(initialName);
      setDesc(initialDescription);
    }
  }, [open, initialName, initialDescription]);
  const err = name ? validateName(lib, name, exceptId) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} width={420}>
      <form
        className="col gap12"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || err) return;
          onSubmit(name.trim(), desc.trim());
          onClose();
        }}
      >
        <Field label="Name" error={err}>
          <Input
            aria-label="Workspace name"
            autoFocus
            value={name}
            invalid={!!err}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <Input
            aria-label="Workspace description"
            value={desc}
            maxLength={500}
            onChange={(e) => setDesc(e.target.value)}
          />
        </Field>
        <div className="row gap8" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !!err}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ library pane

function WorkspaceCard({
  w,
  selected,
  loaded,
  onSelect,
  onRename,
}: {
  w: StoredWorkspace;
  selected: boolean;
  loaded: boolean;
  onSelect(): void;
  onRename(): void;
}) {
  useTimeFormat();
  const tab = w.doc.tabs.find((t) => t.id === w.doc.activeTab) ?? w.doc.tabs[0]!;
  const tiles = useMemo(() => tabTiles(tab), [tab]);
  const name = w.meta.name;
  return (
    <div
      className="wsm-card"
      data-testid="ws-card"
      data-name={name}
      aria-selected={selected}
      role="option"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={() => loadWorkspace(w.meta.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') loadWorkspace(w.meta.id);
      }}
    >
      <Thumbnail tiles={tiles} label={name} />
      <div className="wsm-card-head">
        <span className="wsm-card-name" title={name}>
          {name}
        </span>
        <button
          type="button"
          className="wsm-star"
          aria-pressed={w.meta.favourite}
          aria-label={`Favourite ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavourite(w.meta.id);
          }}
        >
          <Star size={13} fill={w.meta.favourite ? 'currentColor' : 'none'} />
        </button>
        <DropdownMenu
          align="end"
          items={[
            { id: 'load', label: 'Load', onSelect: () => void loadWorkspace(w.meta.id) },
            { id: 'rename', label: 'Rename…', onSelect: onRename },
            { id: 'dup', label: 'Duplicate', onSelect: () => void duplicateWorkspace(w.meta.id) },
            {
              id: 'export',
              label: 'Export .htworkspace',
              onSelect: () => exportWorkspace(w.meta.id),
            },
            { kind: 'separator', id: 's' },
            {
              id: 'delete',
              label: 'Delete…',
              onSelect: () =>
                void askConfirm({
                  title: 'Delete workspace',
                  body: `Delete "${name}"? This cannot be undone (export it first to keep a copy).`,
                  confirmLabel: 'Delete',
                  danger: true,
                }).then((ok) => ok && deleteWorkspace(w.meta.id)),
            },
          ]}
          trigger={
            <IconButton label={`Actions for ${name}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={13} />
            </IconButton>
          }
        />
      </div>
      <div className="wsm-card-desc">{w.meta.description || '—'}</div>
      <div className="wsm-card-foot tnum">
        {loaded && <Badge kind="live">Loaded</Badge>}
        <span>
          {w.doc.tabs.length} layout{w.doc.tabs.length > 1 ? 's' : ''} ·{' '}
          {w.doc.tabs.reduce((a, t) => a + Object.keys(t.windows).length, 0)} windows
        </span>
        <span className="grow" />
        <span title="Last saved">{fmtDateTime(w.meta.updatedAt, { seconds: false })}</span>
      </div>
    </div>
  );
}

function LibraryPane({
  params,
  setParams,
  onSaveAs,
  onRename,
}: {
  params: { query: string; sort: WorkspaceSort; favOnly: boolean; selected: string | null };
  setParams(p: Record<string, unknown>): void;
  onSaveAs(): void;
  onRename(id: string): void;
}) {
  const lib = useWorkspaces((s) => s.lib);
  const autosaveSec = useSetting('general.autosaveSec');
  useTimeFormat();
  let items = filterWorkspaces(lib.items, params.query);
  if (params.favOnly) items = items.filter((w) => w.meta.favourite);
  items = sortWorkspaces(items, params.sort);
  const selected = lib.items.find((w) => w.meta.id === params.selected) ?? null;
  const recent = lib.recent
    .map((id) => lib.items.find((w) => w.meta.id === id))
    .filter((w): w is StoredWorkspace => !!w);
  const starterTiles = useMemo(
    () => STARTER_WORKSPACES.map((s) => tabTiles(s.build().tabs[0]!)),
    [],
  );
  return (
    <div className="wsm-pane">
      <div className="wsm-toolbar">
        <Button
          size="sm"
          variant="primary"
          onClick={() => saveCurrent()}
          data-testid="ws-save-current"
        >
          <Save size={12} /> Save current
        </Button>
        <Button size="sm" onClick={onSaveAs} data-testid="ws-save-as">
          Save as…
        </Button>
        <Button
          size="sm"
          onClick={() => pickWorkspaceFile((id) => setParams({ selected: id }))}
          data-testid="ws-import"
        >
          <Upload size={12} /> Import .htworkspace
        </Button>
        <span className="muted wsm-autosave tnum" data-testid="ws-autosave">
          Autosave every {autosaveSec} s
          {lib.autosavedAt ? ` · last ${fmtClock(lib.autosavedAt)}` : ''}
        </span>
        <span className="grow" />
        <Input
          aria-label="Search workspaces"
          placeholder="Search…"
          value={params.query}
          onChange={(e) => setParams({ query: e.target.value })}
          style={{ width: 160 }}
        />
        <Select<WorkspaceSort>
          aria-label="Sort workspaces"
          small
          value={params.sort}
          onChange={(v) => setParams({ sort: v })}
          options={[
            { value: 'updated', label: 'Last saved' },
            { value: 'name', label: 'Name' },
            { value: 'created', label: 'Created' },
            { value: 'favourites', label: 'Favourites first' },
          ]}
        />
        <Chip selected={params.favOnly} onClick={() => setParams({ favOnly: !params.favOnly })}>
          <Star size={11} /> Favourites
        </Chip>
      </div>
      {recent.length > 0 && (
        <div className="wsm-recent" aria-label="Recent workspaces">
          <span className="muted">Recent</span>
          {recent.map((w) => (
            <Chip
              key={w.meta.id}
              variant="ghost"
              selected={w.meta.id === lib.currentId}
              onClick={() => loadWorkspace(w.meta.id)}
            >
              {w.meta.name}
            </Chip>
          ))}
        </div>
      )}
      <div className="wsm-scroll">
        {items.length === 0 ? (
          <EmptyState title={lib.items.length ? 'No workspace matches' : 'No saved workspaces yet'}>
            {lib.items.length
              ? 'Change the search or the favourites filter.'
              : 'Save the current layout, import a .htworkspace file or start from a starter below.'}
          </EmptyState>
        ) : (
          <div className="wsm-grid" role="listbox" aria-label="Saved workspaces">
            {items.map((w) => (
              <WorkspaceCard
                key={w.meta.id}
                w={w}
                selected={w.meta.id === params.selected}
                loaded={w.meta.id === lib.currentId}
                onSelect={() => setParams({ selected: w.meta.id })}
                onRename={() => onRename(w.meta.id)}
              />
            ))}
          </div>
        )}
        <h3 className="wsm-h">Starter workspaces</h3>
        <div className="wsm-grid wsm-grid--starters">
          {STARTER_WORKSPACES.map((s, i) => (
            <div key={s.id} className="wsm-card wsm-card--starter" data-testid="ws-starter">
              <Thumbnail tiles={starterTiles[i]!} label={s.name} />
              <div className="wsm-card-head">
                <span className="wsm-card-name">{s.name}</span>
                <Button
                  size="xs"
                  onClick={() => addStarter(s.id)}
                  aria-label={`Use starter ${s.name}`}
                >
                  Use
                </Button>
              </div>
              <div className="wsm-card-desc">{s.description}</div>
            </div>
          ))}
        </div>
      </div>
      {selected && (
        <div className="wsm-selbar" data-testid="ws-selbar">
          <span className="wsm-sel-name">{selected.meta.name}</span>
          <Input
            aria-label="Selected workspace description"
            placeholder="Description"
            defaultValue={selected.meta.description}
            key={selected.meta.id}
            onBlur={(e) =>
              e.target.value !== selected.meta.description &&
              setDescription(selected.meta.id, e.target.value)
            }
            style={{ flex: 1, minWidth: 120 }}
          />
          <Button size="sm" variant="primary" onClick={() => loadWorkspace(selected.meta.id)}>
            Load
          </Button>
          <Button size="sm" onClick={() => onRename(selected.meta.id)}>
            Rename
          </Button>
          <Button size="sm" onClick={() => duplicateWorkspace(selected.meta.id)}>
            Duplicate
          </Button>
          <Button size="sm" onClick={() => exportWorkspace(selected.meta.id)}>
            <Download size={12} /> Export
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              void askConfirm({
                title: 'Delete workspace',
                body: `Delete "${selected.meta.name}"? This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true,
              }).then((ok) => {
                if (!ok) return;
                deleteWorkspace(selected.meta.id);
                setParams({ selected: null });
              })
            }
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ manage pane

function ManagePane({
  selected,
  setParams,
}: {
  selected: string | null;
  setParams(p: Record<string, unknown>): void;
}) {
  const lib = useWorkspaces((s) => s.lib);
  const windows = useWindows((s) => s.windows);
  const [node, setNode] = useState<string | null>(null);
  const target = selected ?? lib.currentId ?? '__live';
  const saved = lib.items.find((w) => w.meta.id === target);
  const isLive = !saved || saved.meta.id === lib.currentId;
  // The loaded workspace is shown live (with unsaved changes); others as saved.
  const doc: WorkspaceDoc | null = useMemo(() => {
    if (isLive) return workspaceHost()?.snapshot() ?? saved?.doc ?? null;
    return saved!.doc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, saved, windows]);
  const openIds = useMemo(() => new Set(Object.keys(windows)), [windows]);
  const tree = useMemo(
    () => (doc ? manageTree(doc, windowLabel, isLive ? openIds : new Set()) : null),
    [doc, isLive, openIds],
  );
  const summary = useMemo(() => (doc ? summarize(doc) : null), [doc]);
  const options = [
    ...(lib.currentId ? [] : [{ value: '__live', label: 'Current (unsaved)' }]),
    ...lib.items.map((w) => ({
      value: w.meta.id,
      label: w.meta.name + (w.meta.id === lib.currentId ? ' (loaded)' : ''),
    })),
  ];
  if (!doc || !tree || !summary)
    return <EmptyState title="No workspace">Save the current layout first.</EmptyState>;
  const info = node ? tree.info.get(node) : undefined;
  const nodeWindow = info?.windowId
    ? doc.tabs.find((t) => t.id === info.tabId)?.windows[info.windowId]
    : undefined;
  const removeWindow = () => {
    if (!info?.windowId) return;
    if (isLive && info.open) {
      workspaceHost()?.closeWindow?.(info.windowId);
    } else if (saved) {
      replaceSavedDoc(saved.meta.id, removeWindowFromDoc(saved.doc, info.tabId, info.windowId));
    }
    setNode(null);
  };
  return (
    <div className="wsm-pane">
      <div className="wsm-toolbar">
        <span className="muted">Manage workspace</span>
        <Combobox
          aria-label="Workspace to manage"
          value={target}
          options={options}
          onChange={(v) => setParams({ selected: v === '__live' ? null : v })}
        />
        <span className="grow" />
        {saved && !isLive && (
          <Button size="sm" variant="primary" onClick={() => loadWorkspace(saved.meta.id)}>
            Load
          </Button>
        )}
      </div>
      <SplitPane defaultRatio={0.58} minA={220} minB={200} aria-label="Resize tree and summary">
        <div className="wsm-tree" data-testid="ws-tree">
          <TreeView
            aria-label="Workspace contents"
            nodes={tree.nodes}
            defaultExpanded={tree.nodes.map((n) => n.id)}
            selectedId={node}
            onSelect={setNode}
            renderLabel={(n) => {
              const i = tree.info.get(n.id);
              return (
                <span className="wsm-node">
                  <span className="wsm-node-label">{n.label}</span>
                  {i?.detail && (
                    <span className={`wsm-node-detail${i.open ? ' wsm-open' : ''}`}>
                      {i.detail}
                    </span>
                  )}
                </span>
              );
            }}
          />
        </div>
        <div className="wsm-side">
          {info && (
            <div className="wsm-node-actions">
              <div className="wsm-sel-name">{nodeWindow ? windowLabel(nodeWindow) : info.kind}</div>
              {info.kind === 'window' && isLive && info.open && (
                <Button size="sm" onClick={() => workspaceHost()?.focusWindow?.(info.windowId!)}>
                  Show window
                </Button>
              )}
              {info.kind === 'window' && (
                <Button size="sm" variant="destructive" onClick={removeWindow}>
                  {isLive && info.open ? 'Close window' : 'Remove from workspace'}
                </Button>
              )}
            </div>
          )}
          <table className="wsm-summary tnum" data-testid="ws-summary">
            <tbody>
              {(
                [
                  ['Layouts', summary.layouts],
                  ['Windows', summary.windows],
                  ['Total instruments', summary.instruments],
                  ['Total charts', summary.charts],
                  ['DOM windows', summary.doms],
                  ['Other windows', summary.modules],
                  ['Total drawing objects', summary.drawings],
                  ['Indicators', summary.indicators],
                  ['Total heatmaps', summary.heatmaps],
                  ['Chart templates used', summary.templates.length],
                  ['Workspace size', formatBytes(summary.bytes)],
                ] as const
              ).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}:</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.templates.length > 0 && (
            <div className="muted wsm-templates">Templates: {summary.templates.join(', ')}</div>
          )}
          <div className="muted wsm-templates">Disk used by history: see Data manager.</div>
        </div>
      </SplitPane>
    </div>
  );
}

// ------------------------------------------------------------------ link groups pane

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function LinksPane() {
  const windows = useWindows((s) => s.windows);
  const [sel, setSel] = useState<LinkColor>('red');
  const groups = useMemo(() => linkGroups(windows), [windows]);
  const group = groups.find((g) => g.color === sel)!;
  const instOptions = useMemo(
    () =>
      allInstruments(isTauri).map((i) => ({ value: i.id, label: `${i.symbol} — ${i.exchange}` })),
    [],
  );
  const columns: TableColumn<LinkGroupInfo>[] = [
    {
      key: 'color',
      header: 'Group',
      width: 110,
      sortable: true,
      sortValue: (g) => LINK_COLOR_IDS.indexOf(g.color),
      render: (g) => (
        <span className="row gap8" style={{ alignItems: 'center' }}>
          <span className="wsm-dot" style={{ background: LINK_COLORS[g.color] }} />
          {g.color === 'none' ? 'Not linked' : cap(g.color)}
        </span>
      ),
    },
    {
      key: 'count',
      header: 'Windows',
      width: 70,
      align: 'right',
      numeric: true,
      sortable: true,
      sortValue: (g) => g.windowIds.length,
      render: (g) => g.windowIds.length,
    },
    {
      key: 'instruments',
      header: 'Instrument',
      render: (g) =>
        g.instruments.map((i) => instrumentById(i)?.symbol ?? i).join(', ') || (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'members',
      header: 'Members',
      render: (g) => g.windowIds.map((id) => windowLabel(windows[id]!)).join(' · '),
    },
  ];
  const groupInst = group.instruments[0] ?? null;
  return (
    <div className="wsm-pane" data-testid="ws-links">
      <div className="wsm-links-table">
        <Table
          aria-label="Link groups"
          columns={columns}
          rows={groups}
          rowId={(g) => g.color}
          selectionMode="single"
          selected={new Set([sel])}
          onSelectionChange={(ids) => {
            const v = [...ids][0];
            if (v) setSel(v as LinkColor);
          }}
          height={170}
        />
      </div>
      <div className="wsm-toolbar">
        <span className="wsm-dot" style={{ background: LINK_COLORS[sel] }} />
        <b>{sel === 'none' ? 'Not linked' : `${cap(sel)} group`}</b>
        <span className="muted">
          {group.windowIds.length} window{group.windowIds.length === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        {sel !== 'none' && group.windowIds.length > 0 && (
          <>
            <span className="muted">Instrument</span>
            <Combobox
              aria-label="Group instrument"
              value={groupInst}
              options={instOptions}
              valueLabel={groupInst ? (instrumentById(groupInst)?.symbol ?? groupInst) : undefined}
              onChange={(v) => {
                const first = group.windowIds.find((id) => windows[id]!.kind !== 'module');
                if (first)
                  useWindows.getState().patch(first, { instrumentId: v } as Partial<WindowState>);
                // Linked module windows (tape, options) follow through their params.
                for (const id of group.windowIds) {
                  const w = useWindows.getState().windows[id];
                  if (w?.kind === 'module')
                    useWindows
                      .getState()
                      .patch(id, {
                        params: { ...(w.params ?? {}), instrumentId: v },
                      } as Partial<WindowState>);
                }
              }}
            />
          </>
        )}
      </div>
      <div className="wsm-scroll">
        {group.windowIds.length === 0 ? (
          <EmptyState title="No windows in this group">
            Use the link dot in a window header, or a window&apos;s ⋯ menu → Link group.
          </EmptyState>
        ) : (
          <ul className="wsm-members">
            {group.windowIds.map((id) => {
              const w = windows[id]!;
              return (
                <li key={id} className="wsm-member" data-testid="ws-link-member">
                  <span className="wsm-dot" style={{ background: LINK_COLORS[windowLink(w)] }} />
                  <span className="grow">{windowLabel(w)}</span>
                  <Select<LinkColor>
                    small
                    aria-label={`Link group of ${windowLabel(w)}`}
                    value={windowLink(w)}
                    onChange={(c) => setLink(id, c)}
                    options={LINK_COLOR_IDS.map((c) => ({
                      value: c,
                      label: c === 'none' ? 'No link' : cap(c),
                    }))}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => workspaceHost()?.focusWindow?.(id)}
                  >
                    Show
                  </Button>
                  {windowLink(w) !== 'none' && (
                    <Button size="xs" variant="ghost" onClick={() => setLink(id, 'none')}>
                      Unlink
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ window

export function WorkspacesWindow({ state, setParams }: ModuleViewProps) {
  const p = state.params ?? {};
  const pane: Pane = p.pane === 'manage' || p.pane === 'links' ? p.pane : 'library';
  const sort: WorkspaceSort = ['name', 'updated', 'created', 'favourites'].includes(
    p.sort as string,
  )
    ? (p.sort as WorkspaceSort)
    : 'updated';
  const params = {
    query: typeof p.query === 'string' ? p.query : '',
    sort,
    favOnly: p.favOnly === true,
    selected: typeof p.selected === 'string' ? p.selected : null,
  };
  const lib = useWorkspaces((s) => s.lib);
  const loaded = useWorkspaces((s) => s.loaded);
  const [dialog, setDialog] = useState<{ kind: 'save-as' } | { kind: 'rename'; id: string } | null>(
    null,
  );

  useEffect(() => void ensureLibrary(), []);
  useEffect(() => {
    const run = (a: WorkspacesAction | null) => {
      if (a === 'save-as') setDialog({ kind: 'save-as' });
      else if (a === 'rename') {
        const id = useWorkspaces.getState().lib.currentId;
        if (id) setDialog({ kind: 'rename', id });
      } else if (a === 'manage') setParams({ pane: 'manage' });
      else if (a === 'links') setParams({ pane: 'links' });
    };
    run(takePendingAction());
    const on = () => run(takePendingAction());
    window.addEventListener('htflow:workspaces-action', on);
    return () => window.removeEventListener('htflow:workspaces-action', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renaming =
    dialog?.kind === 'rename' ? lib.items.find((w) => w.meta.id === dialog.id) : undefined;
  const liveName = workspaceHost()?.snapshot().name ?? 'Workspace';

  return (
    <div className="wsm-win" data-testid="workspaces-window">
      <Tabs<Pane>
        value={pane}
        onChange={(v) => setParams({ pane: v })}
        tabs={[
          { value: 'library', label: `Workspaces${loaded ? ` (${lib.items.length})` : ''}` },
          { value: 'manage', label: 'Manage workspace' },
          { value: 'links', label: 'Link groups' },
        ]}
      />
      {pane === 'library' && (
        <LibraryPane
          params={params}
          setParams={setParams}
          onSaveAs={() => setDialog({ kind: 'save-as' })}
          onRename={(id) => setDialog({ kind: 'rename', id })}
        />
      )}
      {pane === 'manage' && <ManagePane selected={params.selected} setParams={setParams} />}
      {pane === 'links' && <LinksPane />}
      <NameDialog
        open={dialog?.kind === 'save-as'}
        title="Save workspace as"
        initialName={liveName}
        initialDescription=""
        confirmLabel="Save"
        onClose={() => setDialog(null)}
        onSubmit={(name, desc) => {
          const id = saveAs(name, desc);
          if (id) setParams({ selected: id });
        }}
      />
      <NameDialog
        open={dialog?.kind === 'rename' && !!renaming}
        title="Rename workspace"
        initialName={renaming?.meta.name ?? ''}
        initialDescription={renaming?.meta.description ?? ''}
        exceptId={renaming?.meta.id}
        confirmLabel="Rename"
        onClose={() => setDialog(null)}
        onSubmit={(name, desc) => {
          if (!renaming) return;
          if (name !== renaming.meta.name) renameWorkspace(renaming.meta.id, name);
          if (desc !== renaming.meta.description) setDescription(renaming.meta.id, desc);
        }}
      />
    </div>
  );
}
