import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Plus, RotateCw, Star, X } from 'lucide-react';
import { Button, Input, toast } from '@htflow/ui-kit';
import { backend, isTauri } from '../../backend';
import { log } from '../../state/log';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  back,
  canBack,
  canForward,
  currentUrl,
  forward,
  navigate,
  newTab,
  normalizeUrl,
  readBookmarks,
  readTabs,
  tabTitle,
  toggleBookmark,
  type Bookmark,
  type Tab,
} from './nav';
import './styles.css';

const BOOKMARKS_KEY = 'web-pages.bookmarks';

/** Links from other windows (RSS, News) arrive as the cancelable `htflow:open-url` event. */
type UrlHandler = (url: string) => void;
const handlers = new Set<UrlHandler>();
const pending: string[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('htflow:open-url', (e) => {
    // The desktop webview's CSP blocks frames (see the Tauri notice below): leave the link to
    // the system browser there instead of claiming it.
    if (isTauri) return;
    const url = normalizeUrl(String((e as CustomEvent).detail ?? ''));
    if (!url) return;
    e.preventDefault();
    const h = [...handlers].at(-1);
    if (h) h(url);
    else {
      pending.push(url);
      window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'web-pages' }));
    }
  });
}

let tabSeq = 0;
const nextTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

function WebPages({ state, setParams }: ModuleViewProps) {
  const tabs = readTabs(state.params?.tabs);
  const activeId =
    typeof state.params?.active === 'string' && tabs.some((t) => t.id === state.params?.active)
      ? (state.params.active as string)
      : tabs[0]!.id;
  const tab = tabs.find((t) => t.id === activeId)!;
  const url = currentUrl(tab);

  const [address, setAddress] = useState(url ?? '');
  const [nonce, setNonce] = useState<Record<string, number>>({});
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Always apply changes on top of the latest params, even from async / event callbacks.
  const live = useRef({ tabs, activeId });
  live.current = { tabs, activeId };
  const commit = useCallback(
    (next: Tab[], active: string) => setParams({ tabs: next, active }),
    [setParams],
  );
  const update = (fn: (t: Tab) => Tab) =>
    commit(
      live.current.tabs.map((t) => (t.id === live.current.activeId ? fn(t) : t)),
      live.current.activeId,
    );

  useEffect(() => setAddress(url ?? ''), [url, activeId]);

  useEffect(() => {
    let alive = true;
    void backend
      .loadSettings<Bookmark[]>(BOOKMARKS_KEY)
      .then((b) => alive && setBookmarks(readBookmarks(b)))
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const saveBookmarks = (next: Bookmark[]) => {
    setBookmarks(next);
    void backend.saveSettings(BOOKMARKS_KEY, next).catch((e) => {
      log.error('web-pages', `Saving bookmarks failed: ${String(e)}`);
      toast('error', 'Could not save bookmarks');
    });
  };

  const openInNewTab = useCallback(
    (u: string) => {
      const t = navigate(newTab(nextTabId()), u);
      commit([...live.current.tabs, t], t.id);
      log.info('web-pages', `Opened ${u}`);
    },
    [commit],
  );

  useEffect(() => {
    handlers.add(openInNewTab);
    for (const u of pending.splice(0)) openInNewTab(u);
    return () => {
      handlers.delete(openInNewTab);
    };
  }, [openInNewTab]);

  const go = (input: string) => {
    const u = normalizeUrl(input);
    if (!u) {
      toast('warning', 'Not a web address', 'Enter an http(s) address such as example.com');
      return;
    }
    update((t) => navigate(t, u));
  };

  const closeTab = (id: string) => {
    const rest = live.current.tabs.filter((t) => t.id !== id);
    if (!rest.length) rest.push(newTab(nextTabId()));
    commit(rest, live.current.activeId === id ? rest[Math.max(0, rest.length - 1)]!.id : live.current.activeId);
  };

  const bookmarked = !!url && bookmarks.some((b) => b.url === url);

  return (
    <div className="web-win col" data-testid="web-pages">
      <div className="web-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`web-tab${t.id === activeId ? ' active' : ''}`}
            onClick={() => commit(tabs, t.id)}
          >
            <span className="ellipsis">{tabTitle(t)}</span>
            <button
              className="web-tab-x"
              aria-label={`Close tab ${tabTitle(t)}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          className="web-tab-add"
          aria-label="New tab"
          onClick={() => {
            const t = newTab(nextTabId());
            commit([...tabs, t], t.id);
          }}
        >
          <Plus size={13} />
        </button>
      </div>

      <form
        className="web-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(address);
        }}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Back"
          disabled={!canBack(tab)}
          onClick={() => update(back)}
        >
          <ArrowLeft size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Forward"
          disabled={!canForward(tab)}
          onClick={() => update(forward)}
        >
          <ArrowRight size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Reload"
          disabled={!url}
          onClick={() => setNonce((n) => ({ ...n, [activeId]: (n[activeId] ?? 0) + 1 }))}
        >
          <RotateCw size={14} />
        </Button>
        <Input
          aria-label="Address"
          className="web-address"
          placeholder="Enter a web address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={bookmarked ? 'Remove bookmark' : 'Add bookmark'}
          aria-pressed={bookmarked}
          disabled={!url}
          onClick={() => url && saveBookmarks(toggleBookmark(bookmarks, url, tabTitle(tab)))}
        >
          <Star size={14} fill={bookmarked ? 'currentColor' : 'none'} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Open in system browser"
          disabled={!url}
          onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={14} />
        </Button>
      </form>

      <div className="web-bookmarks" aria-label="Bookmarks">
        {!loaded ? null : bookmarks.length === 0 ? (
          <span className="muted">No bookmarks yet. Press the star to save the current page.</span>
        ) : (
          bookmarks.map((b) => (
            <span key={b.url} className="web-bm">
              <button className="web-bm-go ellipsis" title={b.url} onClick={() => go(b.url)}>
                {b.title}
              </button>
              <button
                className="web-bm-x"
                aria-label={`Remove bookmark ${b.title}`}
                onClick={() => saveBookmarks(bookmarks.filter((x) => x.url !== b.url))}
              >
                <X size={10} />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="web-view">
        {isTauri && (
          <div className="web-notice" role="note" data-testid="web-tauri-notice">
            <b>Desktop app:</b> pages cannot be framed here because the app&apos;s content security
            policy blocks iframes. The desktop build needs a native child webview (Tauri
            multiwebview, created from Rust and positioned over this area) with an allow-listed
            navigation handler. Until then use <i>Open in system browser</i>.
          </div>
        )}
        {url && !isTauri ? (
          <iframe
            key={`${activeId}:${url}:${nonce[activeId] ?? 0}`}
            className="web-frame"
            title={`Web page ${url}`}
            src={url}
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
            referrerPolicy="no-referrer"
            data-testid="web-frame"
          />
        ) : (
          <div className="web-start muted">
            {url
              ? url
              : 'New tab. Type an address above, or open a bookmark. Some sites refuse to be shown inside other pages; use Open in system browser for those.'}
          </div>
        )}
      </div>
    </div>
  );
}

registerModule({ id: 'web-pages', view: WebPages });
