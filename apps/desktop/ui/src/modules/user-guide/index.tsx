import { Fragment, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button, EmptyState, Input } from '@htflow/ui-kit';
import { BrandIcon, BrandLogo } from '../../components/Brand';
import { commands, onCommandsChange, registerCommands, type Command } from '../../shell/commands';
import { moduleDef } from '../../shell/modules';
import { useWindows } from '../../state/windows';
import { registerModule, type ModuleViewProps } from '../registry';
import { ARTICLES, guideImage } from './content';
import { parseInline, type Block, type Inline, type ListItem } from './markdown';
import { searchArticles, sections, type Article } from './search';
import { consumeGuideRequest, helpTopicFor, openGuide, useGuideRequest } from './topics';
import './styles.css';

const openModule = (id: string) =>
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: id }));

type Nav = (article: string, anchor?: string) => void;

/** Resolves a markdown link: `file.md#anchor`, `#anchor` (same article) or an http(s) URL. */
function resolveLink(
  href: string,
  current: Article,
): { kind: 'guide'; article: string; anchor?: string } | { kind: 'url'; url: string } | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'url', url: href };
  const m = /^([^#]*)(?:#(.*))?$/.exec(href);
  if (!m) return null;
  const file = m[1]!.replace(/\.md$/, '').split('/').pop()!;
  if (!file) return { kind: 'guide', article: current.id, anchor: m[2] };
  const target = ARTICLES.find((a) => a.file === file || a.id === file);
  return target ? { kind: 'guide', article: target.id, anchor: m[2] } : null;
}

function openUrl(url: string) {
  const ev = new CustomEvent('htflow:open-url', { detail: url, cancelable: true });
  if (window.dispatchEvent(ev)) window.open(url, '_blank', 'noopener,noreferrer');
}

function Inl({ parts, article, nav }: { parts: Inline[]; article: Article; nav: Nav }) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case 'code':
            return (
              <code key={i} className="ug-code">
                {p.v}
              </code>
            );
          case 'bold':
            return <b key={i}>{p.v}</b>;
          case 'em':
            return <em key={i}>{p.v}</em>;
          case 'img': {
            const url = guideImage(p.src);
            return url ? <img key={i} className="ug-inline-img" src={url} alt={p.alt} /> : null;
          }
          case 'link': {
            const r = resolveLink(p.href, article);
            if (!r) return <Fragment key={i}>{p.v}</Fragment>;
            return (
              <a
                key={i}
                className="ug-link"
                href={r.kind === 'url' ? r.url : `#${r.anchor ?? r.article}`}
                onClick={(e) => {
                  e.preventDefault();
                  if (r.kind === 'url') openUrl(r.url);
                  else nav(r.article, r.anchor);
                }}
              >
                {p.v}
              </a>
            );
          }
          default:
            return <Fragment key={i}>{p.v}</Fragment>;
        }
      })}
    </>
  );
}

function useCommandList(): Command[] {
  return useSyncExternalStore(onCommandsChange, cmdSnapshot);
}
let snapKey = '';
let snapVal: Command[] = [];
function cmdSnapshot(): Command[] {
  const list = commands().filter((c) => c.shortcut);
  const key = list.map((c) => `${c.id}:${c.shortcut}:${c.scope ?? ''}`).join('|');
  if (key !== snapKey) {
    snapKey = key;
    snapVal = list;
  }
  return snapVal;
}

/** Live table of every command that has a shortcut (includes the user's re-bindings). */
function ShortcutsTable() {
  const list = useCommandList();
  const groups = useMemo(() => {
    const g = new Map<string, Command[]>();
    for (const c of list) g.set(c.group, [...(g.get(c.group) ?? []), c]);
    return [...g.entries()];
  }, [list]);
  return (
    <div data-testid="guide-shortcuts">
      {groups.map(([name, cmds]) => (
        <Fragment key={name}>
          <h4 className="ug-h3">{name}</h4>
          <table className="ug-table">
            <thead>
              <tr>
                <th>Keys</th>
                <th>Command</th>
                <th>Active in</th>
              </tr>
            </thead>
            <tbody>
              {cmds.map((c) => (
                <tr key={c.id}>
                  <td>
                    <code className="ug-code">{c.shortcut}</code>
                  </td>
                  <td>{c.label}</td>
                  <td>{c.scope ?? 'global'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fragment>
      ))}
    </div>
  );
}

function Items({ items, article, nav }: { items: ListItem[]; article: Article; nav: Nav }) {
  return (
    <>
      {items.map((it, j) => (
        <li key={j}>
          <Inl parts={it.inl} article={article} nav={nav} />
          {it.children && <List b={it.children} article={article} nav={nav} />}
        </li>
      ))}
    </>
  );
}

function List({ b, article, nav }: { b: Block; article: Article; nav: Nav }) {
  if (b.t !== 'ul' && b.t !== 'ol') return null;
  const L = b.t === 'ul' ? 'ul' : 'ol';
  return (
    <L>
      <Items items={b.items} article={article} nav={nav} />
    </L>
  );
}

const CALLOUT_TITLE = { tip: 'Tip', note: 'Note', warning: 'Warning', new: 'New' } as const;

function Blocks({ blocks, article, nav }: { blocks: Block[]; article: Article; nav: Nav }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const H = b.level === 2 ? 'h3' : b.level === 3 ? 'h4' : 'h5';
            return (
              <H key={i} id={`ug-${b.id}`} className={b.level === 2 ? 'ug-h2' : 'ug-h3'}>
                <Inl parts={b.inl} article={article} nav={nav} />
              </H>
            );
          }
          case 'p':
            return (
              <p key={i}>
                <Inl parts={b.inl} article={article} nav={nav} />
              </p>
            );
          case 'ul':
          case 'ol':
            return <List key={i} b={b} article={article} nav={nav} />;
          case 'code':
            return (
              <pre key={i} className="ug-pre">
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={i} className="ug-hr" />;
          case 'shortcuts':
            return <ShortcutsTable key={i} />;
          case 'img': {
            const url = guideImage(b.src);
            return url ? (
              <figure key={i} className="ug-fig">
                <img src={url} alt={b.alt} loading="lazy" data-testid="guide-image" />
                <figcaption className="muted">{b.alt}</figcaption>
              </figure>
            ) : (
              <p key={i} className="muted">
                [Image not found: {b.src}]
              </p>
            );
          }
          case 'quote':
            return (
              <aside key={i} className={`ug-callout ug-callout-${b.kind ?? 'plain'}`}>
                {b.kind && <div className="ug-callout-title">{CALLOUT_TITLE[b.kind]}</div>}
                <Blocks blocks={b.blocks} article={article} nav={nav} />
              </aside>
            );
          case 'table':
            return (
              <div key={i} className="ug-table-wrap">
                <table className="ug-table">
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>{h.replace(/`/g, '')}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>
                            <CellInl text={c} article={article} nav={nav} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

function CellInl({ text, article, nav }: { text: string; article: Article; nav: Nav }) {
  return <Inl parts={parseInline(text)} article={article} nav={nav} />;
}

function UserGuide({ state, setParams }: ModuleViewProps) {
  const query = typeof state.params?.query === 'string' ? state.params.query : '';
  const wanted = typeof state.params?.article === 'string' ? state.params.article : '';
  const anchor = typeof state.params?.anchor === 'string' ? state.params.anchor : '';
  const fontSize = Number(state.params?.fontSize) || 13;
  const request = useGuideRequest();
  const hits = useMemo(() => searchArticles(ARTICLES, query), [query]);
  const article =
    ARTICLES.find((a) => a.id === wanted) ?? (query ? hits[0]?.article : ARTICLES[0]) ?? null;
  const groups = useMemo(() => sections(ARTICLES), []);
  const scroller = useRef<HTMLElement>(null);

  const nav: Nav = (id, a) => setParams({ article: id, anchor: a ?? '', query: '' });

  // A "Help for this panel" / palette request is applied once, then cleared.
  useEffect(() => {
    if (!request) return;
    const r = consumeGuideRequest();
    if (r) setParams({ article: r.article, anchor: r.anchor ?? '', query: '' });
  }, [request, setParams]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = anchor ? el.querySelector(`#ug-${CSS.escape(anchor)}`) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else el.scrollTop = 0;
  }, [article?.id, anchor]);

  const idx = article ? ARTICLES.indexOf(article) : -1;
  const prev = idx > 0 ? ARTICLES[idx - 1] : undefined;
  const next = idx >= 0 ? ARTICLES[idx + 1] : undefined;

  return (
    <div className="ug-win" data-testid="user-guide">
      <nav className="ug-toc" aria-label="Table of contents">
        <div className="ug-brand" data-testid="guide-brand">
          <BrandLogo height={72} testId="guide-logo" />
          <div className="row gap8 center-y">
            <BrandIcon size={18} />
            <b>HT Flow User Guide</b>
          </div>
        </div>
        <Input
          aria-label="Search the guide"
          placeholder="Search the guide…"
          value={query}
          onChange={(e) => setParams({ query: e.target.value })}
        />
        {query ? (
          <>
            <div className="muted ug-count">
              {hits.length} result{hits.length === 1 ? '' : 's'}
            </div>
            {hits.length === 0 && <div className="muted ug-count">No articles match</div>}
            {hits.map((h) => (
              <button
                key={`${h.article.id}#${h.anchor}`}
                className="ug-item"
                data-testid="guide-hit"
                onClick={() => nav(h.article.id, h.anchor)}
              >
                {h.article.title}
                {h.heading ? ` › ${h.heading}` : ''}
                {h.snippet && <span className="ug-snip muted">{h.snippet}</span>}
              </button>
            ))}
          </>
        ) : (
          groups.map((g) => (
            <div key={g.name} className="ug-group">
              <div className="ug-group-name">{g.name}</div>
              {g.items.map((a) => (
                <Fragment key={a.id}>
                  <button
                    className={`ug-item${article?.id === a.id ? ' active' : ''}`}
                    onClick={() => nav(a.id)}
                  >
                    {a.title}
                    {a.isNew && <span className="ug-new">new</span>}
                  </button>
                  {article?.id === a.id &&
                    (a.parts ?? [])
                      .filter((p) => p.id)
                      .map((p) => (
                        <button
                          key={p.id}
                          className={`ug-item ug-sub${anchor === p.id ? ' active' : ''}`}
                          onClick={() => nav(a.id, p.id)}
                        >
                          {p.title}
                        </button>
                      ))}
                </Fragment>
              ))}
            </div>
          ))
        )}
      </nav>
      <article
        className="ug-article"
        style={{ fontSize }}
        data-testid="guide-article"
        ref={scroller}
      >
        {article ? (
          <>
            <div className="ug-crumb muted">{article.section}</div>
            <h2 className="ug-title">
              {article.title}
              {article.isNew && <span className="ug-new">new</span>}
            </h2>
            {article.opens && article.opens.length > 0 && (
              <div className="ug-open">
                {article.opens.map((id) => (
                  <Button key={id} size="sm" variant="outline" onClick={() => openModule(id)}>
                    Open {moduleDef(id)?.label ?? id}
                  </Button>
                ))}
              </div>
            )}
            <Blocks blocks={article.blocks ?? []} article={article} nav={nav} />
            <div className="ug-pager">
              {prev ? (
                <Button size="sm" variant="outline" onClick={() => nav(prev.id)}>
                  ← {prev.title}
                </Button>
              ) : (
                <span />
              )}
              {next && (
                <Button size="sm" variant="outline" onClick={() => nav(next.id)}>
                  {next.title} →
                </Button>
              )}
            </div>
            <div className="ug-size muted">
              Text size
              <input
                type="range"
                min={11}
                max={18}
                value={fontSize}
                aria-label="Guide text size"
                onChange={(e) => setParams({ fontSize: Number(e.target.value) })}
              />
            </div>
          </>
        ) : (
          <EmptyState title="No articles match">Try a different search term.</EmptyState>
        )}
      </article>
    </div>
  );
}

registerModule({ id: 'user-guide', label: 'User Guide', view: UserGuide });

registerCommands([
  {
    id: 'user-guide.open',
    label: 'Help: User Guide',
    group: 'Platform',
    keywords: 'help documentation manual shortcuts how to open user guide',
    shortcut: 'F1',
    run: () => openGuide(),
  },
  {
    id: 'user-guide.help-panel',
    label: 'Help: guide for the active window',
    group: 'Platform',
    keywords: 'help this panel context documentation',
    shortcut: 'Shift+F1',
    run: () => {
      const { windows, activeId } = useWindows.getState();
      const w = activeId ? windows[activeId] : undefined;
      openGuide(
        w ? helpTopicFor(w as { kind: string; template?: string; module?: string }) : undefined,
      );
    },
  },
  {
    id: 'user-guide.shortcuts',
    label: 'Help: Keyboard shortcuts',
    group: 'Platform',
    keywords: 'hotkeys keys bindings',
    run: () => openGuide({ article: 'keyboard-shortcuts' }),
  },
]);
