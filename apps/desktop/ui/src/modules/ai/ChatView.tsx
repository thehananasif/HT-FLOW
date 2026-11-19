import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  Copy,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Badge, Button, Checkbox, Chip, Combobox, Input, Kbd, Select, toast } from '@htflow/ui-kit';
import { t, translateLiteral as tl } from '@htflow/i18n';
import { askConfirm } from '../../state/confirm';
import { useSetting } from '../../state/settings';
import { onAi, type AiAction } from './bus';
import { chartTarget } from './chartActions';
import {
  filterConversations,
  PRESETS,
  sortedConversations,
  type ChatMsg,
  type Conversation,
  type ToolResultRec,
} from './chat';
import { OrderCard, StepCard } from './Cards';
import { ContextPanel } from './ContextPanel';
import { LevelsContext, Markdown } from './MarkdownView';
import { providerInfo, providerStatus } from './providers';
import {
  activeConversation,
  ai,
  configById,
  deleteConversation,
  editAndSend,
  isBusy,
  newConversation,
  patchConversation,
  regenerate,
  renameConversation,
  selectConversation,
  send,
  stop,
  supportsVision,
  togglePin,
} from './runtime';
import { parseSlash, QUICK_ACTIONS, suggestSlash, type SlashDef } from './slash';

function useAi() {
  return useSyncExternalStore(ai.subscribe, ai.version);
}

type Img = NonNullable<ChatMsg['attachments']>[number] & { name: string };

const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_IMG = 5 * 1024 * 1024;
const MAX_IMAGES = 3;

function readImage(file: File): Promise<Img | null> {
  if (!(IMG_TYPES as readonly string[]).includes(file.type) || file.size > MAX_IMG)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const data = url.slice(url.indexOf(',') + 1);
      resolve(
        data
          ? { mediaType: file.type as Img['mediaType'], data, name: file.name || 'image' }
          : null,
      );
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ messages */

function resultsOf(conv: Conversation): Map<string, ToolResultRec> {
  const map = new Map<string, ToolResultRec>();
  for (const m of conv.messages) for (const r of m.toolResults ?? []) map.set(r.id, r);
  return map;
}

function MessageView({
  m,
  last,
  results,
  busy,
  onRegenerate,
  onEdit,
}: {
  m: ChatMsg;
  last: boolean;
  results: Map<string, ToolResultRec>;
  busy: boolean;
  onRegenerate(): void;
  onEdit?(): void;
}) {
  const copy = () =>
    navigator.clipboard.writeText(m.text).then(
      () => toast('success', t('ai.copied')),
      () => toast('error', t('ai.copyFailed')),
    );
  // Tool results are shown inside the step cards of the assistant message that made the calls.
  if (m.role === 'tool') return null;
  return (
    <div
      className={`ai-msg ai-msg--${m.role}${m.pending ? ' ai-streaming' : ''}`}
      data-testid={`ai-msg-${m.role}`}
    >
      {m.role === 'user' ? (
        <>
          <div className="ai-user-text">{m.text}</div>
          {(m.hadImage || m.context) && (
            <div className="ai-attach">
              {m.hadImage && <Badge kind="live">{t('ai.screenshotSent')}</Badge>}
              {m.context && (
                <details>
                  <summary>{t('ai.screenContextSummary')}</summary>
                  <pre>{m.context}</pre>
                </details>
              )}
            </div>
          )}
          {onEdit && (
            <div className="ai-msg-actions">
              <button type="button" onClick={onEdit} data-testid="ai-edit-last">
                <Pencil size={11} aria-hidden /> {t('ai.editMessage')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {m.text ? (
            <LevelsContext.Provider
              value={{ enabled: !m.pending, ref: chartTarget()?.last ?? null }}
            >
              <Markdown text={m.text} />
            </LevelsContext.Provider>
          ) : m.pending && !m.toolCalls?.length ? (
            <div className="ai-typing" aria-label={t('ai.thinking')}>
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {m.toolCalls?.map((c) =>
            c.name === 'place_order' ? (
              <OrderCard key={c.id} callId={c.id} args={c.arguments} result={results.get(c.id)} />
            ) : (
              <StepCard key={c.id} call={c} result={results.get(c.id)} running={busy} />
            ),
          )}
          {m.error && (
            <div className="ai-error" role="alert">
              {m.error}
            </div>
          )}
          {!m.pending && (m.text || m.error) && (
            <div className="ai-msg-actions">
              {m.text && (
                <button type="button" onClick={copy}>
                  <Copy size={11} aria-hidden /> {t('ai.copy')}
                </button>
              )}
              {last && (
                <button type="button" onClick={onRegenerate} data-testid="ai-regenerate">
                  <RefreshCw size={11} aria-hidden /> {t('ai.regenerate')}
                </button>
              )}
              {m.usage && (
                <span className="tnum">
                  {t('ai.usage', { input: m.usage.input, output: m.usage.output })}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ chat pane */

function ChatPane({ conv }: { conv: Conversation }) {
  useAi();
  const st = ai.state();
  const shotPref = useSetting('privacy.aiScreenshot');
  const ctxPref = useSetting('privacy.aiContext');
  const [text, setText] = useState('');
  const [shot, setShot] = useState(false);
  const [ctx, setCtx] = useState(ctxPref);
  const [images, setImages] = useState<Img[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [sIdx, setSIdx] = useState(0);
  const [sOff, setSOff] = useState(false);
  const busy = isBusy(conv.id);
  const vision = supportsVision(conv);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const cfg = configById(conv.configId);
  const models = cfg?.models.length ? cfg.models : [conv.model].filter(Boolean);
  const sugg = useMemo(() => (sOff ? [] : suggestSlash(text)), [text, sOff]);
  const results = resultsOf(conv);
  const imagesAllowed = vision && shotPref !== 'never';

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    if (shotPref === 'auto' && vision) setShot(true);
    if (shotPref === 'never' || !vision) {
      setShot(false);
      setImages([]);
    }
  }, [shotPref, vision]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      if (shotPref === 'never') return void toast('info', t('ai.screenshotsOff'));
      if (!vision) return void toast('info', t('ai.noImages'));
      const got = (await Promise.all(files.map(readImage))).filter((x): x is Img => !!x);
      if (got.length < files.length)
        toast('warning', t('ai.imageRejected'), t('ai.imageRejectedBody'));
      if (got.length) setImages((cur) => [...cur, ...got].slice(0, MAX_IMAGES));
    },
    [shotPref, vision],
  );

  /** Shared by Send, quick actions and slash commands. Consent for images is asked here. */
  const submit = useCallback(
    async (raw: string, o: { shot?: boolean; ctx?: boolean; images?: Img[] } = {}) => {
      if (busy) return;
      const wantShot = (o.shot ?? shot) && vision && shotPref !== 'never';
      const imgs = (o.images ?? images).filter(() => imagesAllowed);
      if (!raw.trim() && !wantShot && !imgs.length) return;
      let attach = wantShot;
      let keep = imgs;
      if ((attach || keep.length) && shotPref === 'ask') {
        const ok = await askConfirm({
          title: t('ai.shotConfirmTitle'),
          body: t('ai.shotConfirmBody', {
            provider: cfg?.label ?? conv.provider,
            model: conv.model,
          }),
          confirmLabel: t('ai.shotConfirmOk'),
        });
        if (!ok) {
          attach = false;
          keep = [];
        }
      }
      const editId = editing;
      setText('');
      setEditing(null);
      setImages([]);
      if (shotPref !== 'auto') setShot(false);
      stick.current = true;
      const opts = {
        text: raw,
        screenshot: attach,
        context: o.ctx ?? ctx,
        attachments: keep.map(({ mediaType, data }) => ({ mediaType, data })),
      };
      if (editId) await editAndSend(conv, editId, opts);
      else await send(conv, opts);
    },
    [busy, shot, vision, shotPref, images, imagesAllowed, cfg, conv, editing, ctx],
  );

  const runSlash = useCallback(
    (def: SlashDef, rest: string) => {
      const prompt = t(`ai.prompt.${def.id}` as 'ai.prompt.analyse');
      void submit(rest ? `${prompt}\n${rest}` : prompt, { shot: def.screenshot, ctx: true });
    },
    [submit],
  );

  const send1 = () => {
    const parsed = parseSlash(text);
    if (parsed) runSlash(parsed.def, parsed.rest);
    else void submit(text);
  };

  const editLast = useCallback(() => {
    if (busy) return;
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    setText(lastUser.text);
    setEditing(lastUser.id);
    inputRef.current?.focus();
  }, [busy, conv.messages]);

  // Command palette / quick actions arrive through the bus.
  useEffect(
    () =>
      onAi((a: AiAction) => {
        switch (a.type) {
          case 'quick': {
            const q = QUICK_ACTIONS.find((x) => x.id === a.id);
            if (!q) return true;
            const def = { id: q.slash, screenshot: q.screenshot } as SlashDef;
            runSlash(def, '');
            return true;
          }
          case 'fill':
            setText(a.text);
            setCtx(true);
            if (a.shot && vision && shotPref !== 'never') setShot(true);
            inputRef.current?.focus();
            return true;
          case 'stop':
            stop(conv.id);
            return true;
          case 'editLast':
            editLast();
            return true;
          case 'regenerate':
            void regenerate(conv);
            return true;
          case 'focus':
            inputRef.current?.focus();
            return true;
          default:
            return false;
        }
      }),
    [runSlash, vision, shotPref, conv, editLast],
  );

  const acceptSlash = (d: SlashDef) => {
    setText(`/${d.name} `);
    setSOff(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sugg.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : sugg.length - 1)) % sugg.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
        const d = sugg[Math.min(sIdx, sugg.length - 1)]!;
        if (e.key === 'Tab' || text.trim() !== `/${d.name}`) {
          e.preventDefault();
          acceptSlash(d);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSOff(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send1();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (busy) stop(conv.id);
      else if (editing) {
        setEditing(null);
        setText('');
      }
    } else if (e.key === 'ArrowUp' && !text && !busy) {
      e.preventDefault();
      editLast();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  };

  const lastIdx = conv.messages.length - 1;
  const lastUserId = [...conv.messages].reverse().find((m) => m.role === 'user')?.id;

  return (
    <div
      className={`ai-chat col${drag ? ' is-drop' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={onDrop}
      data-testid="ai-chat"
    >
      <div className="ai-chat-head">
        <Select<string>
          aria-label={t('ai.provider')}
          small
          value={conv.configId}
          onChange={(v) => patchConversation(conv.id, { configId: v })}
          options={st.configs.map((c) => ({
            value: c.id,
            label: `${c.label}${c.hasKey || !providerInfo(c.kind).needsKey ? '' : t('ai.noKeySuffix')}`,
          }))}
        />
        <Combobox
          aria-label={t('ai.model')}
          className="ai-model-pick"
          value={conv.model}
          allowCustom
          placeholder={t('ai.searchModels')}
          options={(models.includes(conv.model) ? models : [conv.model, ...models])
            .filter(Boolean)
            .map((m) => ({ value: m, label: m }))}
          onChange={(v) => patchConversation(conv.id, { model: v })}
        />
        <Select<string>
          aria-label={t('ai.preset')}
          small
          value={conv.presetId}
          onChange={(v) => patchConversation(conv.id, { presetId: v })}
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
      </div>
      {conv.presetId === 'custom' && (
        <textarea
          className="ai-system"
          aria-label={t('ai.systemPrompt')}
          placeholder={t('ai.systemPromptPlaceholder')}
          value={conv.system}
          onChange={(e) => patchConversation(conv.id, { system: e.target.value })}
        />
      )}
      <div
        className="ai-messages"
        ref={listRef}
        data-testid="ai-messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {conv.messages.length === 0 && (
          <div className="ai-empty">
            <p>{t('ai.emptyChat')}</p>
            <p className="ai-hint">{t('ai.emptyHint')}</p>
          </div>
        )}
        {conv.messages.map((m, i) => (
          <MessageView
            key={m.id}
            m={m}
            last={i === lastIdx && m.role === 'assistant' && !busy}
            busy={busy && i >= lastIdx - 1}
            results={results}
            onRegenerate={() => void regenerate(conv)}
            onEdit={m.id === lastUserId && !busy ? editLast : undefined}
          />
        ))}
      </div>
      {drag && <div className="ai-drop">{t('ai.dropImage')}</div>}
      <div className="ai-composer">
        <div className="ai-quick" role="group" aria-label={t('ai.quick.title')}>
          {QUICK_ACTIONS.map((q) => (
            <Chip
              key={q.id}
              variant="outlined"
              disabled={busy}
              onClick={() => runSlash({ id: q.slash, screenshot: q.screenshot } as SlashDef, '')}
              data-testid={`ai-qa-${q.id}`}
              title={t(`ai.quick.${q.id}.hint` as 'ai.quick.analyse.hint')}
            >
              {t(`ai.quick.${q.id}` as 'ai.quick.analyse')}
            </Chip>
          ))}
        </div>
        <div className="ai-composer-opts">
          <Checkbox checked={ctx} onChange={setCtx} label={t('ai.screenContext')} />
          <Button
            size="sm"
            variant={shot ? 'primary' : 'outline'}
            disabled={!vision || shotPref === 'never'}
            onClick={() => setShot(!shot)}
            data-testid="ai-shot-toggle"
            title={
              !vision
                ? t('ai.noImages')
                : shotPref === 'never'
                  ? t('ai.screenshotsOff')
                  : t('ai.attachShot')
            }
          >
            {t('ai.seeScreen')}
          </Button>
          {shot && (
            <span className="ai-shot-chip" data-testid="ai-shot-chip">
              {t('ai.shotAttached')}
              {shotPref === 'ask' ? t('ai.shotConfirmFirst') : ''}
              <button type="button" aria-label={t('ai.removeShot')} onClick={() => setShot(false)}>
                ×
              </button>
            </span>
          )}
          {images.map((im, i) => (
            <span className="ai-shot-chip" key={`${im.name}${i}`} data-testid="ai-image-chip">
              <img src={`data:${im.mediaType};base64,${im.data}`} alt="" />
              {im.name}
              <button
                type="button"
                aria-label={t('ai.removeImage', { name: im.name })}
                onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {editing && (
          <div className="ai-editing" data-testid="ai-editing">
            {t('ai.editing')}
            <button type="button" onClick={() => (setEditing(null), setText(''))}>
              <X size={11} aria-hidden /> {t('ai.cancel')}
            </button>
          </div>
        )}
        <div className="ai-composer-row">
          <div className="ai-input-wrap">
            {sugg.length > 0 && (
              <ul
                className="ai-slash"
                role="listbox"
                aria-label={t('ai.slash.title')}
                data-testid="ai-slash"
              >
                {sugg.map((d, i) => (
                  <li
                    key={d.id}
                    role="option"
                    aria-selected={i === Math.min(sIdx, sugg.length - 1)}
                    className={i === Math.min(sIdx, sugg.length - 1) ? 'is-active' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptSlash(d);
                    }}
                  >
                    <code>/{d.name}</code>
                    <span>{t(`ai.slash.${d.id}` as 'ai.slash.analyse')}</span>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={inputRef}
              aria-label={t('ai.message')}
              data-testid="ai-input"
              value={text}
              placeholder={t('ai.inputPlaceholder')}
              onChange={(e) => {
                setText(e.target.value);
                setSOff(false);
                setSIdx(0);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </div>
          {busy ? (
            <Button variant="destructive" onClick={() => stop(conv.id)} data-testid="ai-stop">
              {t('ai.stop')}
            </Button>
          ) : (
            <Button variant="primary" onClick={send1} data-testid="ai-send">
              {t('ai.send')}
            </Button>
          )}
        </div>
        <div className="ai-keys" aria-hidden>
          <span>
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {t('ai.keys.send')}
          </span>
          <span>
            <Kbd>Esc</Kbd> {t('ai.keys.stop')}
          </span>
          <span>
            <Kbd>↑</Kbd> {t('ai.keys.edit')}
          </span>
          <span>
            <Kbd>/</Kbd> {t('ai.keys.commands')}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ left rail */

function Rail() {
  useAi();
  const st = ai.state();
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const list = useMemo(
    () => filterConversations(sortedConversations(st.convs), q),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st.convs, q, st.v],
  );
  const active = activeConversation();
  const commit = (id: string) => {
    renameConversation(id, name);
    setRenaming(null);
  };
  return (
    <div className="ai-convs col" data-testid="ai-rail">
      <Button size="sm" variant="primary" onClick={() => newConversation()} data-testid="ai-new">
        {t('ai.newChat')}
      </Button>
      <div className="ai-search">
        <Search size={12} aria-hidden />
        <Input
          aria-label={t('ai.searchChats')}
          placeholder={t('ai.searchChats')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="ai-search"
        />
      </div>
      <div className="ai-conv-list" role="list">
        {list.map((c) => (
          <div
            key={c.id}
            role="listitem"
            className={`ai-conv${c.id === st.activeId ? ' is-active' : ''}${c.pinned ? ' is-pinned' : ''}`}
            data-testid="ai-conv"
          >
            {renaming === c.id ? (
              <Input
                autoFocus
                aria-label={t('ai.renameChat')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => commit(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(c.id);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                data-testid="ai-rename-input"
              />
            ) : (
              <button
                type="button"
                className="ai-conv-main"
                onClick={() => selectConversation(c.id)}
                onDoubleClick={() => (setRenaming(c.id), setName(tl(c.title)))}
              >
                <span className="ai-conv-title">
                  {c.pinned && <Pin size={10} aria-hidden />} {tl(c.title)}
                </span>
                <span className="ai-conv-meta">{c.model}</span>
              </button>
            )}
            <span className="ai-conv-actions">
              <button
                type="button"
                aria-label={c.pinned ? t('ai.unpinChat') : t('ai.pinChat')}
                title={c.pinned ? t('ai.unpinChat') : t('ai.pinChat')}
                onClick={() => togglePin(c.id)}
                data-testid="ai-pin"
              >
                {c.pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
              </button>
              <button
                type="button"
                aria-label={t('ai.renameChat')}
                title={t('ai.renameChat')}
                onClick={() => (setRenaming(c.id), setName(tl(c.title)))}
                data-testid="ai-rename"
              >
                <Pencil size={12} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t('ai.deleteChat', { title: tl(c.title) })}
                title={t('ai.deleteChatShort')}
                onClick={async () => {
                  if (
                    c.messages.length &&
                    !(await askConfirm({
                      title: t('ai.deleteChatTitle'),
                      body: t('ai.deleteChatBody', { title: tl(c.title) }),
                      confirmLabel: t('ai.deleteChatShort'),
                      danger: true,
                    }))
                  )
                    return;
                  deleteConversation(c.id);
                }}
                data-testid="ai-delete"
              >
                <Trash2 size={12} aria-hidden />
              </button>
            </span>
          </div>
        ))}
        {list.length === 0 && <div className="ai-hint ai-rail-empty">{t('ai.noChats')}</div>}
      </div>
      <div className="ai-providers-rail" data-testid="ai-provider-chips">
        <div className="ai-rail-label">{t('ai.providers')}</div>
        {st.configs.map((c) => {
          const s = providerStatus(c, st.health[c.id]);
          const h = st.health[c.id];
          const tip =
            s === 'ok'
              ? t('ai.status.okTip', { ms: h?.ms ?? 0 })
              : s === 'failed'
                ? t('ai.status.failedTip', { error: h?.error ?? '' })
                : s === 'nokey'
                  ? t('ai.status.nokey')
                  : t('ai.status.untested');
          return (
            <button
              key={c.id}
              type="button"
              className={`ai-pchip${active?.configId === c.id ? ' is-active' : ''}`}
              data-state={s}
              data-testid={`ai-chip-${c.id}`}
              title={tip}
              aria-label={`${c.label}: ${tip}`}
              onClick={() => active && patchConversation(active.id, { configId: c.id })}
            >
              <span className="ai-dot" data-state={s} aria-hidden />
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tab */

export function ChatTab() {
  useAi();
  const conv = activeConversation();
  const ref = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState(true);
  const [ctx, setCtx] = useState(true);
  // Narrow windows start with the side panels closed.
  useEffect(() => {
    const w = ref.current?.clientWidth ?? 1000;
    if (w < 820) setCtx(false);
    if (w < 620) setRail(false);
  }, []);
  return (
    <div className="ai-chat-layout" ref={ref}>
      <div className="ai-toggles">
        <button
          type="button"
          aria-pressed={rail}
          aria-label={t('ai.toggleRail')}
          title={t('ai.toggleRail')}
          onClick={() => setRail(!rail)}
          data-testid="ai-toggle-rail"
        >
          <PanelLeft size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-pressed={ctx}
          aria-label={t('ai.toggleContext')}
          title={t('ai.toggleContext')}
          onClick={() => setCtx(!ctx)}
          data-testid="ai-toggle-context"
        >
          <PanelRight size={13} aria-hidden />
        </button>
      </div>
      {rail && <Rail />}
      {conv ? (
        <ChatPane key={conv.id} conv={conv} />
      ) : (
        <div className="ai-empty">
          <Button variant="primary" onClick={() => newConversation()}>
            {t('ai.startChat')}
          </Button>
        </div>
      )}
      {ctx && <ContextPanel />}
    </div>
  );
}
