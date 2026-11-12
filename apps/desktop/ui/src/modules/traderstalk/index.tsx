import { useMemo, useState } from 'react';
import { Badge, Button, Input, Select, toast } from '@htflow/ui-kit';
import type { ChartCore } from '@htflow/chart-engine';
import {
  exportIdeas,
  extractTags,
  filterIdeas,
  mergeIdeas,
  normalizeIdea,
  parseIdeaFile,
  parseTagInput,
  IDEA_TEXT_MAX,
  type Idea,
} from '@htflow/info';
import { registerChartExtension } from '../../charts/extensions';
import { useSession } from '../../state/session';
import { useWindows } from '../../state/windows';
import { allInstruments, DEFAULT_INSTRUMENT, instrumentById } from '../../state/instruments';
import { isTauri } from '../../backend';
import { registerOpenFileHandler } from '../../platform/openFile';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  activeChartId,
  download,
  PersistedStore,
  pickTextFile,
  useStore,
  userTimezone,
} from '../rss/shared';
import '../rss/styles.css';

interface TalkState {
  version: 1;
  ideas: Idea[];
}

const talk = new PersistedStore<TalkState>(
  'traderstalk',
  () => ({ version: 1, ideas: [] }),
  (raw) => {
    const list =
      raw && typeof raw === 'object' && Array.isArray((raw as TalkState).ideas)
        ? (raw as TalkState).ideas
        : [];
    return { version: 1, ideas: list.map(normalizeIdea).filter((i): i is Idea => i !== null) };
  },
);

// Double-clicking a .htidea file (file association) merges it into the idea log.
registerOpenFileHandler('idea', async (f) => {
  await talk.ensureLoaded();
  const p = parseIdeaFile(f.text);
  const m = mergeIdeas(talk.get().ideas, p.ideas);
  talk.set({ ...talk.get(), ideas: m.ideas });
  toast('success', `Imported ${m.added} new, ${m.updated} updated idea(s)`, f.name);
});

// Chart cores per chart window, so a snapshot can be taken of the active chart.
const coresByWindow = new Map<string, ChartCore[]>();
registerChartExtension({
  id: 'traderstalk-snapshot',
  attach: (ctx) => {
    coresByWindow.set(ctx.windowId, ctx.cores);
    return () => {
      if (coresByWindow.get(ctx.windowId) === ctx.cores) coresByWindow.delete(ctx.windowId);
    };
  },
});

/** Active chart as a JPEG data URL (both canvases side by side for split charts), max 1200 px wide. */
function snapshotActiveChart(): string | null {
  const id = activeChartId();
  let canvases: HTMLCanvasElement[] = (id && coresByWindow.get(id)?.map((c) => c.canvas)) || [];
  if (!canvases.length) {
    const c = document.querySelector<HTMLCanvasElement>('.chart-host canvas');
    if (c) canvases = [c];
  }
  if (!canvases.length) return null;
  const w = canvases.reduce((a, c) => a + c.width, 0);
  const h = Math.max(...canvases.map((c) => c.height));
  if (!w || !h) return null;
  const scale = Math.min(1, 1200 / w);
  const out = document.createElement('canvas');
  out.width = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const g = out.getContext('2d');
  if (!g) return null;
  let x = 0;
  for (const c of canvases) {
    g.drawImage(c, x * scale, 0, c.width * scale, c.height * scale);
    x += c.width;
  }
  return out.toDataURL('image/jpeg', 0.82);
}

const BLOCKED = [
  'Peer-to-peer sharing / live chat rooms',
  'Public idea feed and following other traders',
  'Sync ideas between devices',
];

function TradersTalk({ state: win, setParams }: ModuleViewProps) {
  const s = useStore(talk);
  const tz = userTimezone();
  const author = useSession((x) => x.session?.displayName ?? 'Me');
  const windows = useWindows((x) => x.windows);
  const instFilter = (win.params?.instrument as string | undefined) ?? '';
  const [text, setText] = useState('');
  const [tagText, setTagText] = useState('');
  const [snap, setSnap] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);

  const chartInst = useMemo(() => {
    const id = activeChartId();
    const w = id ? windows[id] : undefined;
    return w && w.kind === 'chart' ? w.instrumentId : DEFAULT_INSTRUMENT;
  }, [windows]);
  const target = instFilter || chartInst;
  const counts = new Map<string, number>();
  for (const i of s.ideas) counts.set(i.instrumentId, (counts.get(i.instrumentId) ?? 0) + 1);
  const ideas = filterIdeas(s.ideas, { instrumentId: instFilter || null, tag, query });
  const allTags = [...new Set(s.ideas.flatMap((i) => i.tags))].sort();

  const post = () => {
    if (!text.trim() && !snap) return;
    const now = Date.now();
    const idea: Idea = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      instrumentId: target,
      symbol: instrumentById(target)?.symbol ?? target,
      createdAt: now,
      updatedAt: now,
      author,
      text: text.slice(0, IDEA_TEXT_MAX),
      tags: [...new Set([...extractTags(text), ...parseTagInput(tagText)])],
    };
    if (snap) idea.snapshot = snap;
    talk.set({ ...s, ideas: [...s.ideas, idea] });
    setText('');
    setTagText('');
    setSnap(null);
  };

  return (
    <div className="module-window" data-testid="traderstalk">
      <div className="info-toolbar">
        <b>TradersTalk</b>
        <span className="muted">local idea log — stored encrypted in your profile</span>
        <span className="grow" />
        <Input
          style={{ width: 160 }}
          placeholder="Search ideas"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          size="sm"
          onClick={() =>
            download(
              `htflow-ideas-${new Date().toISOString().slice(0, 10)}.htidea`,
              exportIdeas(ideas),
              'application/json',
            )
          }
        >
          Export .htidea
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void pickTextFile('.htidea,application/json').then((t) => {
              if (!t) return;
              try {
                const p = parseIdeaFile(t);
                const m = mergeIdeas(talk.get().ideas, p.ideas);
                talk.set({ ...talk.get(), ideas: m.ideas });
                toast(
                  'success',
                  `Imported ${m.added} new, ${m.updated} updated`,
                  p.skipped ? `${p.skipped} invalid skipped` : undefined,
                );
              } catch (e) {
                toast('error', 'Import failed', e instanceof Error ? e.message : String(e));
              }
            })
          }
        >
          Import .htidea
        </Button>
      </div>
      <div className="tt-cols">
        <nav className="rss-tree" aria-label="Instruments">
          <div className="rss-tree-title">Instruments</div>
          <button
            className="rss-node"
            aria-pressed={!instFilter}
            onClick={() => setParams({ instrument: '' })}
          >
            <span className="grow">All</span>
            <span className="tnum muted">{s.ideas.length || ''}</span>
          </button>
          {allInstruments(isTauri).map((i) => (
            <button
              key={i.id}
              className="rss-node"
              aria-pressed={instFilter === i.id}
              onClick={() => setParams({ instrument: i.id })}
            >
              <span className="grow ellipsis mono">{i.symbol}</span>
              <span className="tnum muted">{counts.get(i.id) || ''}</span>
            </button>
          ))}
          {allTags.length > 0 && <div className="rss-tree-title">Tags</div>}
          <div className="row wrap gap6" style={{ padding: '0 8px' }}>
            {allTags.map((t) => (
              <button
                key={t}
                className="ht-chip"
                aria-pressed={tag === t}
                onClick={() => setTag(tag === t ? null : t)}
              >
                #{t}
              </button>
            ))}
          </div>
          <div className="rss-tree-title" style={{ marginTop: 12 }}>
            Needs a server
          </div>
          {BLOCKED.map((b) => (
            <div key={b} className="tt-blocked" style={{ padding: '2px 8px' }}>
              <Badge kind="error">BLOCKED</Badge> {b}
            </div>
          ))}
          <div className="tt-blocked" style={{ padding: '4px 8px' }}>
            HT Flow has no server ($0). Share ideas by exporting a .htidea file.
          </div>
        </nav>
        <div className="col" style={{ minHeight: 0 }}>
          <div className="tt-msgs">
            {ideas.length === 0 && (
              <div className="tbl-empty">No ideas yet — write the first one below.</div>
            )}
            {ideas.map((i) => (
              <div key={i.id} className="tt-msg">
                <div className="row between muted gap8">
                  <span>
                    <span className="info-tag mono">{i.symbol}</span> {i.author}
                  </span>
                  <span className="row gap8 center-y">
                    <span className="tnum">
                      {new Date(i.createdAt).toLocaleString('en-GB', { timeZone: tz })}
                    </span>
                    <button
                      className="link"
                      onClick={() => {
                        if (window.confirm('Delete this idea?'))
                          talk.set({ ...s, ideas: s.ideas.filter((x) => x.id !== i.id) });
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </div>
                {i.text && <p>{i.text}</p>}
                {i.tags.length > 0 && (
                  <div className="muted">{i.tags.map((t) => `#${t}`).join(' ')}</div>
                )}
                {i.snapshot && <img src={i.snapshot} alt={`${i.symbol} chart snapshot`} />}
              </div>
            ))}
          </div>
          <div className="tt-compose">
            <div className="row gap8 center-y">
              <span className="muted">Instrument</span>
              <Select
                small
                aria-label="Idea instrument"
                value={target}
                onChange={(v) => setParams({ instrument: v })}
                options={allInstruments(isTauri).map((i) => ({ value: i.id, label: i.symbol }))}
              />
              <Input
                style={{ flex: 1 }}
                placeholder="Tags (comma separated)"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => {
                  const d = snapshotActiveChart();
                  if (d) setSnap(d);
                  else toast('info', 'Open a chart window to attach a snapshot');
                }}
              >
                {snap ? 'Retake snapshot' : 'Attach chart snapshot'}
              </Button>
              {snap && (
                <button className="link" onClick={() => setSnap(null)}>
                  Remove snapshot
                </button>
              )}
            </div>
            <textarea
              aria-label="Idea text"
              placeholder="Write an idea… (#tags work too, Ctrl+Enter to post)"
              value={text}
              maxLength={IDEA_TEXT_MAX}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) post();
              }}
            />
            <div className="row gap8 center-y">
              {snap && (
                <img src={snap} alt="snapshot preview" style={{ height: 40, borderRadius: 4 }} />
              )}
              <span className="grow" />
              <Button variant="primary" size="sm" disabled={!text.trim() && !snap} onClick={post}>
                Post idea
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

registerModule({ id: 'traderstalk', view: TradersTalk });
