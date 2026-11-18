import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Plus,
  RotateCw,
  Settings2,
  Star,
  X,
} from 'lucide-react';
import { Button, Input, toast } from '@htflow/ui-kit';
import { backend, isTauri } from '../../backend';
import { log } from '../../state/log';
import { registerCommands } from '../../shell/commands';
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
import { listenNative, nativePage, type Bounds } from './native';
import { checkAddress, normalizeAllowList, parseAllowText, urlPermitted } from './policy';
import './styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
const BOOKMARKS_KEY = 'web-pages.bookmarks';

/** Links from other windows (RSS, News) arrive as the cancelable `htflow:open-url` event. */
type UrlHandler = (url: string) => void;
const handlers = new Set<UrlHandler>();
const pending: string[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('htflow:open-url', (e) => {
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

/** Palette commands reach the most recently mounted Web Pages panel through this event. */
export const WEBPAGES_CMD = 'htflow:webpages-cmd';
export type WebpagesCmd = 'reload' | 'system' | 'allow' | 'bookmark' | 'show';

let tabSeq = 0;
const nextTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

function WebPages({ windowId, state, setParams }: ModuleViewProps) {
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
  const [showSettings, setShowSettings] = useState(false);
  const [shown, setShown] = useState(false);
  const allow = normalizeAllowList(
    Array.isArray(state.params?.allow) ? (state.params.allow as string[]).map(String) : [],
  );
  const newWindowExternal = state.params?.newWindow === 'system';
  const alwaysOnTop = state.params?.alwaysOnTop === true;
  const savedBounds = state.params?.bounds as Bounds | undefined;
  const [allowText, setAllowText] = useState(allow.join('\n'));

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
  const cfg = useRef({ allow, newWindowExternal, alwaysOnTop, savedBounds });
  cfg.current = { allow, newWindowExternal, alwaysOnTop, savedBounds };
  const updateRef = useRef(update);
  updateRef.current = update;
  /** URL the native window is known to show; avoids re-navigating to what it already displays. */
  const nativeUrl = useRef<string | null>(null);

  const showNative = useCallback(
    (u: string) => {
      if (!isTauri) return;
      const c = cfg.current;
      nativeUrl.current = u;
      setShown(true);
      void nativePage
        .open(windowId, u, {
          allow: c.allow,
          newWindowExternal: c.newWindowExternal,
          alwaysOnTop: c.alwaysOnTop,
          bounds: c.savedBounds,
        })
        .catch((e) => {
          setShown(false);
          log.error('web-pages', `Opening the page window failed: ${errText(e)}`);
          toast('error', tl('Could not open the page window'), errText(e));
        });
    },
    [windowId],
  );

  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | null = null;
    let dead = false;
    void listenNative(windowId, {
      navigated: (u) => {
        nativeUrl.current = u;
        updateRef.current((t) => navigate(t, u));
      },
      bounds: (b) => setParams({ bounds: b }),
      closed: () => {
        nativeUrl.current = null;
        setShown(false);
      },
    })
      .then((o) => (dead ? o() : (off = o)))
      .catch(() => undefined);
    return () => {
      dead = true;
      off?.();
      void nativePage.close(windowId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId]);

  // Switching tabs (or any other change of the current address) re-points the open window.
  useEffect(() => {
    if (isTauri && shown && url && nativeUrl.current !== url) showNative(url);
  }, [url, shown, showNative]);

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
      toast('error', tl('Could not save bookmarks'));
    });
  };

  const openInNewTab = useCallback(
    (u: string) => {
      if (!urlPermitted(u, cfg.current.allow)) {
        toast('warning', tl('Blocked by the allow-list'), u);
        return;
      }
      const t = navigate(newTab(nextTabId()), u);
      commit([...live.current.tabs, t], t.id);
      showNative(u);
      log.info('web-pages', `Opened ${u}`);
    },
    [commit, showNative],
  );

  useEffect(() => {
    handlers.add(openInNewTab);
    for (const u of pending.splice(0)) openInNewTab(u);
    return () => {
      handlers.delete(openInNewTab);
    };
  }, [openInNewTab]);

  const go = (input: string) => {
    const r = checkAddress(input, allow);
    if (!r.ok) {
      toast('warning', tl('Not opened'), r.reason);
      return;
    }
    update((t) => navigate(t, r.url));
    showNative(r.url);
  };

  const systemBrowser = (u: string) => {
    if (isTauri)
      void nativePage
        .openExternal(u)
        .catch((e) => toast('error', tl('Could not open'), errText(e)));
    else window.open(u, '_blank', 'noopener,noreferrer');
  };

  const saveAllow = () => {
    const { list, rejected } = parseAllowText(allowText);
    if (rejected.length) toast('warning', tl('Ignored invalid entries'), rejected.join(', '));
    setParams({ allow: list });
    setAllowText(list.join('\n'));
    cfg.current = { ...cfg.current, allow: list };
    if (isTauri)
      void nativePage
        .setPolicy(windowId, list, cfg.current.newWindowExternal)
        .catch(() => undefined);
    toast('success', list.length ? `Allow-list: ${list.length} site(s)` : 'Allow-list cleared');
  };

  const setNewWindow = (external: boolean) => {
    setParams({ newWindow: external ? 'system' : 'same' });
    cfg.current = { ...cfg.current, newWindowExternal: external };
    if (isTauri)
      void nativePage.setPolicy(windowId, cfg.current.allow, external).catch(() => undefined);
  };

  const setOnTop = (on: boolean) => {
    setParams({ alwaysOnTop: on });
    if (isTauri && shown) void nativePage.setAlwaysOnTop(windowId, on).catch(() => undefined);
  };

  const doReload = () => {
    if (isTauri) void nativePage.reload(windowId).catch(() => url && showNative(url));
    else setNonce((n) => ({ ...n, [activeId]: (n[activeId] ?? 0) + 1 }));
  };

  const cmdRef = useRef<(c: WebpagesCmd) => void>(() => undefined);
  cmdRef.current = (c) => {
    if (c === 'reload') doReload();
    else if (c === 'system') {
      if (url) systemBrowser(url);
    } else if (c === 'allow') setShowSettings(true);
    else if (c === 'bookmark') {
      if (url) saveBookmarks(toggleBookmark(bookmarks, url, tabTitle(tab)));
    } else if (c === 'show') {
      if (url) showNative(url);
    }
  };
  useEffect(() => {
    const h = (e: Event) => {
      if ([...handlers].at(-1) !== openInNewTab) return;
      cmdRef.current((e as CustomEvent<WebpagesCmd>).detail);
    };
    window.addEventListener(WEBPAGES_CMD, h);
    return () => window.removeEventListener(WEBPAGES_CMD, h);
  }, [openInNewTab]);

  const closeTab = (id: string) => {
    const rest = live.current.tabs.filter((t) => t.id !== id);
    if (!rest.length) rest.push(newTab(nextTabId()));
    commit(
      rest,
      live.current.activeId === id ? rest[Math.max(0, rest.length - 1)]!.id : live.current.activeId,
    );
  };

  const bookmarked = !!url && bookmarks.some((b) => b.url === url);

  return (
    <div className="web-win col" data-testid="web-pages">
      <div className="web-tabs" role="tablist" aria-label={tl('Browser tabs')}>
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
          aria-label={tl('New tab')}
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
          aria-label={tl('Back')}
          disabled={isTauri ? !shown : !canBack(tab)}
          onClick={() =>
            isTauri ? void nativePage.back(windowId).catch(() => undefined) : update(back)
          }
        >
          <ArrowLeft size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={tl('Forward')}
          disabled={isTauri ? !shown : !canForward(tab)}
          onClick={() =>
            isTauri ? void nativePage.forward(windowId).catch(() => undefined) : update(forward)
          }
        >
          <ArrowRight size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={tl('Reload')}
          disabled={!url}
          onClick={doReload}
        >
          <RotateCw size={14} />
        </Button>
        <Input
          aria-label={tl('Address')}
          className="web-address"
          placeholder={tl('Enter a web address')}
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
          aria-label={tl('Open in system browser')}
          disabled={!url}
          onClick={() => url && systemBrowser(url)}
        >
          <ExternalLink size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={tl('Panel settings')}
          aria-pressed={showSettings}
          onClick={() => setShowSettings((v) => !v)}
        >
          <Settings2 size={14} />
        </Button>
      </form>

      {showSettings && (
        <div className="web-settings" data-testid="web-settings">
          <label className="web-set-row">
            <span>
              {tl('Allowed sites')}{' '}
              <span className="muted">{tl('(one per line; empty allows every site)')}</span>
            </span>
            <textarea
              aria-label={tl('Allowed sites')}
              className="web-allow"
              rows={3}
              placeholder={tl('example.com\n*.example.org')}
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
            />
          </label>
          <div className="web-set-row inline">
            <Button type="button" size="sm" onClick={saveAllow}>
              {tl('Save allow-list')}
            </Button>
            <label className="web-chk">
              <input
                type="checkbox"
                checked={newWindowExternal}
                onChange={(e) => setNewWindow(e.target.checked)}
              />
              {tl('Open new-window links in the system browser')}
            </label>
            {isTauri && (
              <label className="web-chk">
                <input
                  type="checkbox"
                  checked={alwaysOnTop}
                  onChange={(e) => setOnTop(e.target.checked)}
                />
                {tl('Keep page window on top')}
              </label>
            )}
          </div>
        </div>
      )}

      <div className="web-bookmarks" aria-label={tl('Bookmarks')}>
        {!loaded ? null : bookmarks.length === 0 ? (
          <span className="muted">
            {tl('No bookmarks yet. Press the star to save the current page.')}
          </span>
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
        {url && !isTauri && (
          <div className="web-notice" role="note" data-testid="web-frame-hint">
            {tl(
              'Blank page or a refusal message? Many sites forbid being shown inside other pages (X-Frame-Options / frame-ancestors) and a browser cannot tell us when that happens.',
            )}{' '}
            <button className="web-link" onClick={() => systemBrowser(url)}>
              {tl('Open in system browser')}
            </button>
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
        ) : url && isTauri ? (
          <div className="web-start" data-testid="web-native-card">
            <p className="muted">
              {shown
                ? 'This page is open in its own window (it keeps its size and position).'
                : 'The page window is closed.'}
            </p>
            <p className="ellipsis">{url}</p>
            <Button type="button" size="sm" onClick={() => showNative(url)}>
              {shown ? 'Bring window to front' : 'Show page window'}
            </Button>
          </div>
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

function errText(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

const openModule = () =>
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'web-pages' }));
const cmd = (c: WebpagesCmd) => () => {
  openModule();
  window.dispatchEvent(new CustomEvent(WEBPAGES_CMD, { detail: c }));
};

registerCommands([
  {
    id: 'webpages.open',
    label: 'Web Pages: Open browser panel',
    group: 'Info',
    keywords: 'web browser internet page url bookmarks',
    run: openModule,
  },
  {
    id: 'webpages.reload',
    label: 'Web Pages: Reload page',
    group: 'Info',
    keywords: 'refresh browser',
    run: cmd('reload'),
  },
  {
    id: 'webpages.bookmark',
    label: 'Web Pages: Bookmark / unbookmark this page',
    group: 'Info',
    keywords: 'star favourite',
    run: cmd('bookmark'),
  },
  {
    id: 'webpages.system-browser',
    label: 'Web Pages: Open this page in the system browser',
    group: 'Info',
    keywords: 'external default browser',
    run: cmd('system'),
  },
  {
    id: 'webpages.allow-list',
    label: 'Web Pages: Edit allowed sites…',
    group: 'Info',
    keywords: 'domain allow list whitelist restrict security',
    run: cmd('allow'),
  },
  {
    id: 'webpages.show-window',
    label: 'Web Pages: Show page window (desktop)',
    group: 'Info',
    keywords: 'native webview window bring front',
    run: cmd('show'),
  },
]);

registerModule({ id: 'web-pages', view: WebPages });
