import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Select, toast } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { log } from '../../state/log';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  addFollowed,
  allTags,
  filterFollowed,
  normalizeHandle,
  parseTags,
  readFollowed,
  sampleIdeas,
  validateHandle,
  type Followed,
} from './model';
import './styles.css';

const KEY = 'following.list';

function Following({ state, setParams }: ModuleViewProps) {
  const [list, setList] = useState<Followed[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [handle, setHandle] = useState('');
  const [notes, setNotes] = useState('');
  const [tagText, setTagText] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const query = typeof state.params?.query === 'string' ? state.params.query : '';
  const tag = typeof state.params?.tag === 'string' ? state.params.tag : '';
  const compact = state.params?.compact === true;

  useEffect(() => {
    let alive = true;
    void backend
      .loadSettings<Followed[]>(KEY)
      .then((v) => alive && setList(readFollowed(v)))
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = (next: Followed[]) => {
    setList(next);
    void backend.saveSettings(KEY, next).catch((e) => {
      log.error('following', `Saving list failed: ${String(e)}`);
      toast('error', 'Could not save the list');
    });
  };

  const err = handle ? validateHandle(handle, list) : null;
  const shown = useMemo(() => filterFollowed(list, query, tag), [list, query, tag]);
  const sel = list.find((f) => f.id === selId) ?? null;
  const ideas = useMemo(() => sampleIdeas(shown), [shown]);
  const tags = allTags(list);

  const patch = (id: string, p: Partial<Followed>) =>
    save(list.map((f) => (f.id === id ? { ...f, ...p } : f)));

  return (
    <div className="fol-win col" data-testid="following">
      <div className="fol-banner" role="note" data-testid="following-banner">
        <Badge kind="error">Blocked</Badge>
        <span>
          <b>Requires a sharing server.</b> Following other traders&apos; public ideas and accounts
          needs a service that publishes and delivers them. HT Flow has no server, so this window
          keeps a local list (handle, notes, tags) on this PC and shows <i>sample</i> items to
          preview the layout. Nothing is sent or fetched.
        </span>
      </div>

      <form
        className="fol-add"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const next = addFollowed(list, handle, notes, parseTags(tagText));
            save(next);
            setSelId(next[next.length - 1]!.id);
            setHandle('');
            setNotes('');
            setTagText('');
            log.info('following', `Added ${normalizeHandle(handle)}`);
          } catch (x) {
            toast('warning', 'Cannot add', x instanceof Error ? x.message : String(x));
          }
        }}
      >
        <Field label="Trader handle" error={err}>
          <Input
            aria-label="Trader handle"
            placeholder="@handle"
            value={handle}
            invalid={!!err}
            onChange={(e) => setHandle(e.target.value)}
          />
        </Field>
        <Field label="Notes">
          <Input
            aria-label="Notes"
            placeholder="Why follow?"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <Field label="Tags" hint="comma separated">
          <Input
            aria-label="Tags"
            placeholder="scalper, ES"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!handle || !!err}>
          Add trader
        </Button>
      </form>

      <div className="fol-toolbar">
        <Input
          aria-label="Search following"
          placeholder="Search handle, notes, tags…"
          value={query}
          onChange={(e) => setParams({ query: e.target.value })}
          style={{ width: 220 }}
        />
        <Select<string>
          aria-label="Tag filter"
          value={tag}
          onChange={(v) => setParams({ tag: v })}
          options={[{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t, label: t }))]}
        />
        <Checkbox
          checked={compact}
          onChange={(v) => setParams({ compact: v })}
          label="Compact rows"
        />
        <span className="grow" />
        <Button size="sm" variant="secondary" disabled title="Requires a sharing server">
          Sync with server
        </Button>
        <span className="muted tnum">{shown.length} followed</span>
      </div>

      <div className="fol-body">
        <div className="fol-list" role="list" aria-label="Followed traders">
          {loaded && list.length === 0 && (
            <EmptyState title="Not following anyone yet">
              Add a trader handle above. It is stored only on this PC.
            </EmptyState>
          )}
          {shown.map((f) => (
            <div
              key={f.id}
              role="listitem"
              className={`fol-row${f.id === selId ? ' sel' : ''}${compact ? ' compact' : ''}`}
              onClick={() => setSelId(f.id)}
            >
              <div className="fol-handle">
                @{f.handle}
                {f.muted && <span className="muted"> · muted</span>}
              </div>
              {!compact && f.notes && <div className="fol-notes muted">{f.notes}</div>}
              <div className="fol-tags">
                {f.tags.map((t) => (
                  <span key={t} className="fol-tag">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="fol-detail">
          {sel ? (
            <div className="col gap12">
              <div className="row" style={{ alignItems: 'center' }}>
                <h3 className="fol-title">@{sel.handle}</h3>
                <span className="grow" />
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Unfollow ${sel.handle}`}
                  onClick={() => {
                    save(list.filter((f) => f.id !== sel.id));
                    setSelId(null);
                  }}
                >
                  <Trash2 size={12} /> Unfollow
                </Button>
              </div>
              <Field label="Notes">
                <Input
                  aria-label="Edit notes"
                  value={sel.notes}
                  onChange={(e) => patch(sel.id, { notes: e.target.value })}
                />
              </Field>
              <Field label="Tags" hint="comma separated">
                <Input
                  aria-label="Edit tags"
                  defaultValue={sel.tags.join(', ')}
                  key={sel.id}
                  onBlur={(e) => patch(sel.id, { tags: parseTags(e.target.value) })}
                />
              </Field>
              <Checkbox
                checked={sel.muted}
                onChange={(v) => patch(sel.id, { muted: v })}
                label="Mute in the feed"
              />
              <div className="muted">
                Added {sel.addedAt ? new Date(sel.addedAt).toLocaleDateString() : 'earlier'} ·
                profile, track record and live account stats need the sharing server.
              </div>
            </div>
          ) : (
            <div className="muted">Select a trader to edit notes and tags.</div>
          )}

          <h4 className="fol-sub">Ideas feed (sample data)</h4>
          {ideas.length === 0 ? (
            <div className="muted">Follow someone to preview the feed layout.</div>
          ) : (
            <div className="fol-ideas">
              {ideas.map((i, n) => (
                <div key={n} className="fol-idea">
                  <span className="fol-handle">@{i.handle}</span>
                  <span className={i.side === 'long' ? 'up' : 'down'}>{i.side}</span>
                  <span className="tnum">{i.symbol}</span>
                  <span className="grow ellipsis">{i.title}</span>
                  <span className="muted tnum">{i.hoursAgo}h</span>
                  <Badge>Sample</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

registerModule({ id: 'following', view: Following });
