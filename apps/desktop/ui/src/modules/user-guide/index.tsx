import { Fragment, useMemo } from 'react';
import { Button, EmptyState, Input } from '@htflow/ui-kit';
import { BrandIcon, BrandLogo } from '../../components/Brand';
import { registerCommands } from '../../shell/commands';
import { moduleDef } from '../../shell/modules';
import { registerModule, type ModuleViewProps } from '../registry';
import { ARTICLES } from './content';
import { parseInline, parseMarkdown, type Block, type Inline } from './markdown';
import { searchArticles, sections } from './search';
import './styles.css';

const openModule = (id: string) =>
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: id }));

function Inl({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === 'code' ? (
          <code key={i} className="ug-code">
            {p.v}
          </code>
        ) : p.t === 'bold' ? (
          <b key={i}>{p.v}</b>
        ) : (
          <Fragment key={i}>{p.v}</Fragment>
        ),
      )}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return b.level === 2 ? (
              <h3 key={i} className="ug-h2">
                <Inl parts={b.inl} />
              </h3>
            ) : (
              <h4 key={i} className="ug-h3">
                <Inl parts={b.inl} />
              </h4>
            );
          case 'p':
            return (
              <p key={i}>
                <Inl parts={b.inl} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const L = b.t === 'ul' ? 'ul' : 'ol';
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inl parts={it} />
                  </li>
                ))}
              </L>
            );
          }
          case 'table':
            return (
              <table key={i} className="ug-table">
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
                          <Inl parts={parseInline(c)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </>
  );
}

function UserGuide({ state, setParams }: ModuleViewProps) {
  const query = typeof state.params?.query === 'string' ? state.params.query : '';
  const wanted = typeof state.params?.article === 'string' ? state.params.article : '';
  const fontSize = Number(state.params?.fontSize) || 13;
  const hits = useMemo(() => searchArticles(ARTICLES, query), [query]);
  const article = hits.find((h) => h.article.id === wanted)?.article ?? hits[0]?.article ?? null;
  const blocks = useMemo(() => (article ? parseMarkdown(article.body) : []), [article]);
  const groups = useMemo(() => sections(hits.map((h) => h.article)), [hits]);

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
        {query && <div className="muted ug-count">{hits.length} results</div>}
        {groups.map((g) => (
          <div key={g.name} className="ug-group">
            <div className="ug-group-name">{g.name}</div>
            {g.items.map((a) => {
              const hit = hits.find((h) => h.article.id === a.id)!;
              return (
                <button
                  key={a.id}
                  className={`ug-item${article?.id === a.id ? ' active' : ''}`}
                  onClick={() => setParams({ article: a.id })}
                >
                  {a.title}
                  {query && hit.snippet && <span className="ug-snip muted">{hit.snippet}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <article className="ug-article" style={{ fontSize }} data-testid="guide-article">
        {article ? (
          <>
            <div className="ug-crumb muted">{article.section}</div>
            <h2 className="ug-title">{article.title}</h2>
            {article.opens && article.opens.length > 0 && (
              <div className="ug-open">
                {article.opens.map((id) => (
                  <Button key={id} size="sm" variant="outline" onClick={() => openModule(id)}>
                    Open {moduleDef(id)?.label ?? id}
                  </Button>
                ))}
              </div>
            )}
            <Blocks blocks={blocks} />
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
    label: 'Open User Guide',
    group: 'Platform',
    keywords: 'help documentation manual shortcuts how to',
    shortcut: 'F1',
    run: () => openModule('user-guide'),
  },
]);
