/**
 * Script Editor (P13 custom indicators / P14 "Custom script"): write HT Script indicators, check
 * them live, save them to the per-user library, export / import `.htind` files and add them to
 * the active chart. Scripts are interpreted by a sandboxed engine (no eval, no globals) and run
 * in the indicator worker pool.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FilePlus, PlusSquare, Save, Trash2, Upload } from 'lucide-react';
import {
  SAMPLE_SCRIPT,
  SCRIPT_BUILTINS,
  SCRIPT_PREFIX,
  checkScript,
  createConfig,
  parseHtind,
  serializeHtind,
  type HtindFile,
} from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';
import { t, translateLiteral as tl } from '@htflow/i18n';
import { Badge, Button, Input, toast } from '@htflow/ui-kit';
import { registerCommands } from '../../shell/commands';
import { downloadText } from '../../components/DataTable.utils';
import { registerOpenFileHandler } from '../../platform/openFile';
import { registerModule, type ModuleViewProps } from '../registry';
import { EDITOR_MODULE, openScriptEditor, useEditorTarget } from '../indicators/editorState';
import { uniqueScriptId, useScripts } from '../indicators/scripts';
import { readExt, targetChart, writeExt } from '../indicators/state';
import './styles.css';

interface Params {
  scriptId?: string | null;
  name?: string;
  source?: string;
}

function addToChart(id: string): void {
  const chart = targetChart();
  const def = indicatorById(SCRIPT_PREFIX + id);
  if (!chart || !def) {
    toast('error', tl('No chart to add the script to'), tl('Open a chart window first.'));
    return;
  }
  writeExt(chart, [...readExt(chart).items, createConfig(def)]);
  toast('success', `${def.name} added to the chart`);
}

function ScriptEditor({ state, setParams }: ModuleViewProps) {
  const p = (state.params ?? {}) as Params;
  const scripts = useScripts((s) => s.scripts);
  const target = useEditorTarget();
  const [id, setId] = useState<string | null>(p.scriptId ?? null);
  const [name, setName] = useState(p.name ?? 'Delta momentum');
  const [source, setSource] = useState(p.source ?? SAMPLE_SCRIPT);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const load = (f: HtindFile | null) => {
    setId(f?.id ?? null);
    setName(f?.name ?? 'New script');
    setSource(f?.source ?? SAMPLE_SCRIPT);
  };

  // "Edit" from the Indicators dialog / command palette.
  const seen = useRef(target.nonce);
  useEffect(() => {
    if (target.nonce === seen.current) return;
    seen.current = target.nonce;
    load(target.id ? (scripts.find((s) => s.id === target.id) ?? null) : null);
  }, [target, scripts]);

  useEffect(() => {
    const h = setTimeout(() => setParams({ scriptId: id, name, source }), 300);
    return () => clearTimeout(h);
  }, [id, name, source, setParams]);

  const check = useMemo(() => checkScript(source), [source]);
  const saved = scripts.find((s) => s.id === id);
  const dirty = !saved || saved.source !== source || saved.name !== name;
  const lines = source.split('\n').length;

  const save = (): string | null => {
    if (!check.ok) {
      toast('error', tl('Fix the script before saving'), check.error);
      return null;
    }
    const nm = name.trim() || check.program.meta.name;
    const sid = id ?? uniqueScriptId(nm);
    try {
      useScripts
        .getState()
        .save({ format: 'htind', version: 1, id: sid, name: nm, source, updated: Date.now() });
      setId(sid);
      setName(nm);
      toast('success', `Script "${nm}" saved`, tl('Find it under Indicators → Custom (scripts).'));
      return sid;
    } catch (e) {
      toast('error', tl('Could not save'), e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const exportFile = () => {
    if (!check.ok) return toast('error', tl('Fix the script before exporting'), check.error);
    const nm = name.trim() || check.program.meta.name;
    const f: HtindFile = {
      format: 'htind',
      version: 1,
      id: id ?? uniqueScriptId(nm),
      name: nm,
      source,
      updated: Date.now(),
    };
    downloadText(`${f.id}.htind`, serializeHtind(f), 'application/json');
  };

  const importFile = async (file: File) => {
    try {
      const f = parseHtind(await file.text(), file.name.replace(/\.htind$/i, ''));
      setId(null);
      setName(f.name);
      setSource(f.source);
      toast('success', `Imported ${file.name}`, tl('Save it to add it to your library.'));
    } catch (e) {
      toast('error', `Could not import ${file.name}`, e instanceof Error ? e.message : String(e));
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const a = el.selectionStart;
      const b = el.selectionEnd;
      const next = `${source.slice(0, a)}  ${source.slice(b)}`;
      setSource(next);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="se-root" data-testid="script-editor">
      <aside className="se-list">
        <div className="se-head">{t('scriptEditor.library')}</div>
        <button className="se-item" aria-pressed={id === null} onClick={() => load(null)}>
          <FilePlus size={12} /> {t('scriptEditor.new')}
        </button>
        {scripts.map((s) => (
          <button
            key={s.id}
            className="se-item"
            aria-pressed={s.id === id}
            onClick={() => load(s)}
            data-testid="se-script"
          >
            {s.name}
          </button>
        ))}
        <div className="se-ref">
          <div className="se-head">{t('scriptEditor.reference')}</div>
          <p>
            <b>{tl('Values')}</b> {SCRIPT_BUILTINS.variables.join(' ')} · <code>x[n]</code>{' '}
            {tl('= n bars ago')}
          </p>
          <p>
            <b>{tl('Functions')}</b> {SCRIPT_BUILTINS.functions.join(' ')}
          </p>
          <p>
            <b>{tl('Declarations')}</b> {SCRIPT_BUILTINS.declarations.join(' ')}
          </p>
          <p>
            <b>{tl('Statements')}</b> <code>{tl('let a = expr')}</code> {tl('(or')}{' '}
            <code>{tl('a = expr')}</code>), <code>{tl('var s = 0')}</code> {tl('then')}{' '}
            <code>s := s + 1</code>
            {tl(', operators')} <code>+ - * / % ^ &lt; &gt; == != and or not ?:</code>
          </p>
          <p className="muted">
            {tl('Scripts are sandboxed: no network, files, DOM or host objects — only bar data.')}
          </p>
        </div>
      </aside>
      <section className="se-main">
        <div className="se-bar">
          <Input
            aria-label={tl('Script name')}
            className="se-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          {dirty ? <Badge>{tl('unsaved')}</Badge> : <Badge>{tl('saved')}</Badge>}
          <div className="grow" />
          <Button size="sm" variant="primary" data-testid="se-save" onClick={() => save()}>
            <Save size={12} /> {t('scriptEditor.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="se-add"
            onClick={() => {
              const sid = dirty ? save() : id;
              if (sid) addToChart(sid);
            }}
          >
            <PlusSquare size={12} /> {t('scriptEditor.addToChart')}
          </Button>
          <Button size="sm" variant="outline" onClick={exportFile}>
            <Download size={12} /> {tl('.htind')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload size={12} /> {t('scriptEditor.import')}
          </Button>
          {saved && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={tl('Delete script')}
              onClick={() => {
                useScripts.getState().remove(saved.id);
                load(null);
              }}
            >
              <Trash2 size={12} />
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".htind,application/json,text/plain"
            hidden
            data-testid="se-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <div className="se-code">
          <div className="se-gutter mono" ref={gutterRef} aria-hidden>
            {Array.from({ length: lines }, (_, k) => (
              <div
                key={k}
                className={!check.ok && check.pos?.line === k + 1 ? 'se-err-line' : undefined}
              >
                {k + 1}
              </div>
            ))}
          </div>
          <textarea
            ref={areaRef}
            className="se-area mono"
            aria-label={tl('Script source')}
            data-testid="se-source"
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={onKey}
            onScroll={(e) => {
              if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
          />
        </div>
        <div
          className={`se-status ${check.ok ? '' : 'se-status--err'}`}
          data-testid="se-status"
          role="status"
        >
          {check.ok
            ? `OK · ${check.program.meta.name} · pane ${check.program.meta.pane} · inputs: ${
                Object.values(check.program.inputs)
                  .map((d) => d.label)
                  .join(', ') || 'none'
              } · plots: ${Object.values(check.program.outputs)
                .map((o) => o.label)
                .join(', ')}`
            : `Error ${check.error}`}
        </div>
      </section>
    </div>
  );
}

registerModule({ id: EDITOR_MODULE, label: 'Script Editor', view: ScriptEditor });

registerCommands([
  {
    id: 'indicators.scriptEditor',
    label: 'Indicators: Script Editor (custom .htind indicators)',
    group: 'Chart',
    keywords: 'script code custom indicator htind formula editor',
    run: () => openScriptEditor(null),
  },
]);

// Double-clicked `.htind` files (P30 file association) go straight into the library.
registerOpenFileHandler('indicator', (f) => {
  const file = parseHtind(f.text, f.name.replace(/\.htind$/i, ''));
  const exists = useScripts.getState().scripts.some((s) => s.id === file.id);
  useScripts.getState().save({ ...file, id: exists ? uniqueScriptId(file.name) : file.id });
  toast('success', `Indicator "${file.name}" imported`, tl('Indicators → Custom (scripts).'));
});
