import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, Field, Input, Select, toast } from '@htflow/ui-kit';
import {
  exportOpml,
  highlightSegments,
  matchKeywords,
  normalizeKeywords,
  parseOpml,
  REFRESH_CHOICES,
  setRead,
  sortItems,
  tagLabel,
  tagSymbols,
  unreadCounts,
  type CachedItem,
  type FeedSub,
} from '@htflow/info';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  addFeed,
  FOLDERS,
  KEYWORDS_FOLDER,
  reader,
  refreshAll,
  refreshFeed,
  removeFeed,
} from './store';
import {
  download,
  fmtClock,
  instrumentForTag,
  openChartFor,
  openUrl,
  pickTextFile,
  userTimezone,
  useStore,
} from './shared';
import './styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
type Sel =
  | { kind: 'all' }
  | { kind: 'folder'; name: string }
  | { kind: 'feed'; id: string }
  | { kind: 'keywords' };

export function Highlighted({ text, keywords }: { text: string; keywords: readonly string[] }) {
  return (
    <>
      {highlightSegments(text, keywords).map((s, i) =>
        s.keyword ? (
          <mark key={i} className="info-kw" title={`Keyword: ${s.keyword}`}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function FeedDialog({
  feed,
  open,
  onClose,
}: {
  feed: FeedSub | null;
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(FOLDERS[0]!);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setUrl(feed?.url ?? '');
    setTitle(feed?.title ?? '');
    setFolder(feed?.folder ?? FOLDERS[0]!);
    setErr(null);
  }, [feed, open]);
  const folders = [...new Set([...FOLDERS, ...reader.get().folders])];
  const save = () => {
    if (feed) {
      if (!/^https?:\/\/\S+$/i.test(url.trim()))
        return setErr('Enter an http:// or https:// feed URL');
      reader.update((s) => ({
        ...s,
        folders: s.folders.includes(folder) ? s.folders : [...s.folders, folder],
        feeds: s.feeds.map((f) =>
          f.id === feed.id
            ? {
                ...f,
                url: url.trim(),
                title: title.trim() || url.trim(),
                folder,
                unverified: f.url === url.trim() ? f.unverified : undefined,
              }
            : f,
        ),
      }));
      void refreshFeed(feed.id);
    } else {
      const e = addFeed(url, title, folder);
      if (e) return setErr(e);
    }
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={feed ? 'Edit feed' : 'Add feed URL'}
      width={460}
    >
      <div className="col gap12">
        <Field label={tl('Feed URL (RSS 2.0, RSS 1.0 or Atom)')} error={err}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={tl('https://…/rss.xml')}
            autoFocus
          />
        </Field>
        <Field label={tl('Name')}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tl('Optional')}
          />
        </Field>
        <Field label={tl('Folder')}>
          <Select
            value={folder}
            onChange={setFolder}
            options={folders.map((f) => ({ value: f, label: f }))}
          />
        </Field>
        <div className="row gap8" style={{ justifyContent: 'flex-end' }}>
          {feed && (
            <Button
              variant="destructive"
              onClick={() => {
                removeFeed(feed.id);
                onClose();
              }}
            >
              {tl('Remove feed')}
            </Button>
          )}
          <Button onClick={onClose}>{tl('Cancel')}</Button>
          <Button variant="primary" onClick={save}>
            {feed ? 'Save' : 'Add feed'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RssReader({ state: win, setParams }: ModuleViewProps) {
  const s = useStore(reader);
  const tz = userTimezone();
  const rawSel = win.params?.sel as Sel | undefined;
  const sel = useMemo<Sel>(() => rawSel ?? { kind: 'all' }, [rawSel]);
  const setSel = (v: Sel) => setParams({ sel: v });
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; feed: FeedSub | null }>({
    open: false,
    feed: null,
  });
  const [kwText, setKwText] = useState('');
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => unreadCounts(s), [s]);
  const feedById = useMemo(() => new Map(s.feeds.map((f) => [f.id, f])), [s.feeds]);
  const kwItems = useMemo(
    () => s.items.filter((i) => matchKeywords([i.title, i.summary], s.keywords).length),
    [s.items, s.keywords],
  );
  const list = useMemo(() => {
    let items: CachedItem[] = s.items;
    if (sel.kind === 'folder')
      items = items.filter((i) => feedById.get(i.feedId)?.folder === sel.name);
    else if (sel.kind === 'feed') items = items.filter((i) => i.feedId === sel.id);
    else if (sel.kind === 'keywords') items = kwItems;
    return sortItems(items).slice(0, 500);
  }, [s.items, sel, feedById, kwItems]);
  const item = list.find((i) => i.id === selected) ?? null;
  const folders = [...new Set([...FOLDERS, ...s.folders, ...s.feeds.map((f) => f.folder)])].filter(
    Boolean,
  );
  const loose = s.feeds.filter((f) => !f.folder);
  const sampleShown = s.items.some((i) => i.sample);
  const failing = s.feeds.filter((f) => f.lastError).length;

  const select = (i: CachedItem) => {
    setSelected(i.id);
    if (!i.read) reader.set(setRead(reader.get(), [i.id], true));
  };
  const feedRow = (f: FeedSub) => (
    <button
      key={f.id}
      className="rss-node rss-node--feed"
      aria-pressed={sel.kind === 'feed' && sel.id === f.id}
      onClick={() => setSel({ kind: 'feed', id: f.id })}
      onDoubleClick={() => setDialog({ open: true, feed: f })}
      title={`${f.url}${f.lastError ? `\nLast error: ${f.lastError}` : ''}\nDouble-click to edit`}
    >
      <span className="grow ellipsis">
        {f.title}
        {f.lastError && <span className="warn-dot" aria-label={tl('fetch failed')} />}
      </span>
      <span className="tnum muted">{counts.feeds.get(f.id) || ''}</span>
    </button>
  );
  const tags = item ? tagSymbols(`${item.title}\n${item.summary}`) : [];

  return (
    <div className="module-window rss-window" data-testid="rss-reader">
      <div className="info-toolbar">
        <Button size="sm" variant="primary" onClick={() => setDialog({ open: true, feed: null })}>
          {tl('+ Add feed URL')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refreshAll().finally(() => setBusy(false));
          }}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
        <span className="muted">{tl('Every')}</span>
        <Select
          small
          aria-label={tl('Refresh interval')}
          value={String(s.refreshMin)}
          onChange={(v) => reader.set({ ...reader.get(), refreshMin: Number(v) })}
          options={REFRESH_CHOICES.map((m) => ({
            value: String(m),
            label: m === 0 ? 'Manual' : `${m} min`,
          }))}
        />
        <span className="grow" />
        {sampleShown && <Badge kind="delayed">{tl('Offline sample shown')}</Badge>}
        {!sampleShown && s.items.length === 0 && !failing && (
          <span className="muted" data-testid="rss-loading">
            {tl('Loading feeds…')}
          </span>
        )}
        {failing > 0 && (
          <span className="muted">
            {failing} {tl('feed(s) offline or failing — cached items shown')}
          </span>
        )}
        <Button
          size="sm"
          disabled={counts.total === 0}
          onClick={() =>
            reader.set(
              setRead(
                reader.get(),
                s.items.filter((i) => !i.read).map((i) => i.id),
                true,
              ),
            )
          }
        >
          {tl('Mark all read')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void pickTextFile('.opml,.xml,text/xml').then((text) => {
              if (!text) return;
              try {
                const doc = parseOpml(text);
                let added = 0;
                for (const f of doc.feeds)
                  if (!addFeed(f.xmlUrl, f.title, f.folder || 'Imported')) added++;
                toast(
                  'success',
                  `OPML: ${added} feed(s) added`,
                  `${doc.feeds.length - added} skipped (duplicate or invalid)`,
                );
              } catch (e) {
                toast(
                  'error',
                  tl('OPML import failed'),
                  e instanceof Error ? e.message : String(e),
                );
              }
            })
          }
        >
          {tl('Import OPML')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            download(
              'htflow-feeds.opml',
              exportOpml(
                'HT Flow feeds',
                s.feeds.map((f) => ({ title: f.title, xmlUrl: f.url, folder: f.folder })),
              ),
              'text/x-opml',
            )
          }
        >
          {tl('Export OPML')}
        </Button>
      </div>
      <div className="rss-cols">
        <nav className="rss-tree" aria-label={tl('Folders')}>
          <div className="rss-tree-title">{tl('Folders')}</div>
          <button
            className="rss-node"
            aria-pressed={sel.kind === 'all'}
            onClick={() => setSel({ kind: 'all' })}
          >
            <span className="grow">{tl('All items')}</span>
            <span className="tnum muted">{counts.total || ''}</span>
          </button>
          {folders.map((fo) => (
            <div key={fo}>
              <button
                className="rss-node"
                aria-pressed={sel.kind === 'folder' && sel.name === fo}
                onClick={() => setSel({ kind: 'folder', name: fo })}
              >
                <span className="grow">{fo}</span>
                <span className="tnum muted">{counts.folders.get(fo) || ''}</span>
              </button>
              {s.feeds.filter((f) => f.folder === fo).map(feedRow)}
            </div>
          ))}
          {loose.map(feedRow)}
          <button
            className="rss-node rss-node--kw"
            aria-pressed={sel.kind === 'keywords'}
            onClick={() => setSel({ kind: 'keywords' })}
          >
            <span className="grow">{KEYWORDS_FOLDER} ★</span>
            <span className="tnum muted">{kwItems.filter((i) => !i.read).length || ''}</span>
          </button>
          <div className="rss-kw-edit">
            <div className="row wrap gap6">
              {s.keywords.map((k) => (
                <button
                  key={k}
                  className="ht-chip"
                  title={tl('Remove keyword')}
                  onClick={() => reader.set({ ...s, keywords: s.keywords.filter((x) => x !== k) })}
                >
                  {k} ×
                </button>
              ))}
            </div>
            <Input
              placeholder={tl('Add keyword + Enter')}
              value={kwText}
              onChange={(e) => setKwText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !kwText.trim()) return;
                reader.set({
                  ...s,
                  keywords: normalizeKeywords([...s.keywords, ...kwText.split(',')]),
                });
                setKwText('');
              }}
            />
          </div>
        </nav>
        <div className="rss-list" role="list">
          {list.length === 0 && <div className="tbl-empty">{tl('No items')}</div>}
          {list.map((i) => (
            <button
              key={i.id}
              role="listitem"
              className="rss-item"
              data-unread={!i.read || undefined}
              aria-pressed={i.id === selected}
              onClick={() => select(i)}
            >
              <div className="row between muted rss-item-meta">
                <span className="ellipsis">
                  {feedById.get(i.feedId)?.title ?? '—'}
                  {i.sample ? ' · offline sample' : ''}
                </span>
                <span className="tnum">{fmtClock(i.published ?? i.fetchedAt, tz)}</span>
              </div>
              <div className="rss-item-title">
                <Highlighted text={i.title} keywords={s.keywords} />
              </div>
            </button>
          ))}
        </div>
        <article className="rss-pane">
          {!item ? (
            <div className="tbl-empty">{tl('Select an item')}</div>
          ) : (
            <>
              <div className="muted">
                {feedById.get(item.feedId)?.title} ·{' '}
                {new Date(item.published ?? item.fetchedAt).toLocaleString('en-GB', {
                  timeZone: tz,
                })}
                {item.sample && (
                  <>
                    {' '}
                    <Badge kind="delayed">{tl('offline sample — not real news')}</Badge>
                  </>
                )}
              </div>
              <h2 className="rss-headline">
                <Highlighted text={item.title} keywords={s.keywords} />
              </h2>
              <div className="row wrap gap6">
                {tags.map((t) => (
                  <span key={t.root} className="info-tag mono">
                    {tagLabel(t)}
                  </span>
                ))}
              </div>
              <p className="rss-summary">
                <Highlighted text={item.summary || '(no summary)'} keywords={s.keywords} />
              </p>
              <div className="grow" />
              <div className="row gap8 wrap">
                <Button variant="primary" disabled={!item.link} onClick={() => openUrl(item.link)}>
                  {tl('Open in browser')}
                </Button>
                {tags.slice(0, 2).map((t) => {
                  const inst = instrumentForTag(tagLabel(t));
                  return (
                    <Button
                      key={t.root}
                      variant="outline"
                      disabled={!inst}
                      title={
                        inst ? `Show ${inst} in the active chart` : 'No instrument for this tag'
                      }
                      onClick={() =>
                        inst &&
                        !openChartFor(inst) &&
                        toast('info', tl('Open a chart window first'))
                      }
                    >
                      {tl('Open chart')} {tagLabel(t)}
                    </Button>
                  );
                })}
                <Button
                  variant="outline"
                  onClick={() => reader.set(setRead(reader.get(), [item.id], !item.read))}
                >
                  {item.read ? 'Mark unread' : 'Mark read'}
                </Button>
              </div>
            </>
          )}
        </article>
      </div>
      <FeedDialog
        open={dialog.open}
        feed={dialog.feed}
        onClose={() => setDialog({ open: false, feed: null })}
      />
    </div>
  );
}

registerModule({ id: 'rss', view: RssReader });
