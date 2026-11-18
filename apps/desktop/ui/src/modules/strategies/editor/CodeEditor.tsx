import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { INDICATORS } from '@htflow/indicators';
import { API_DOCS } from './apiDocs';
import type { Diagnostic } from './compile';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--htc-kw, #c792ea)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--htc-str, #c3e88d)' },
  { tag: tags.number, color: 'var(--htc-num, #f78c6c)' },
  { tag: tags.comment, color: 'var(--htc-comment, #6b7a90)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--htc-fn, #82aaff)' },
  { tag: tags.typeName, color: 'var(--htc-type, #ffcb6b)' },
  { tag: tags.propertyName, color: 'var(--htc-prop, #89ddff)' },
  { tag: tags.bool, color: 'var(--htc-num, #f78c6c)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--bg-1, #0f1318)', color: 'var(--fg-1, #d8dee9)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2, #141a21)', color: 'var(--fg-3, #6b7a90)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent, #4fc3f7)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-2, #141a21)', border: '1px solid var(--border, #263241)' },
});

function htCompletions(ctx: CompletionContext): CompletionResult | null {
  // Indicator ids inside indicator('…').
  const ind = ctx.matchBefore(/indicator\(\s*['"][\w-]*/);
  if (ind) {
    const q = ind.text.search(/['"]/) + 1;
    return {
      from: ind.from + q,
      options: INDICATORS.map((i) => ({ label: i.id, type: 'constant', detail: i.name })),
      validFor: /^[\w-]*$/,
    };
  }
  const word = ctx.matchBefore(/[\w.]+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return {
    from: word.from,
    options: API_DOCS.map((a) => ({
      label: a.label,
      type: a.type,
      detail: a.detail,
      info: a.info,
      ...(a.apply ? { apply: a.apply } : {}),
    })),
    validFor: /^[\w.]*$/,
  };
}

export interface CodeEditorProps {
  value: string;
  onChange(v: string): void;
  diagnostics: Diagnostic[];
  /** Changes when another file is shown: the document is replaced, history reset. */
  docKey: string;
  ariaLabel?: string;
}

/** CodeMirror 6 editor with HT Strategy API completion and compiler / runtime markers. */
export function CodeEditor({ value, onChange, diagnostics, docKey, ariaLabel }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const label = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: makeState(value),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; docKey / value changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function makeState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        javascript({ typescript: true }),
        syntaxHighlighting(highlight),
        autocompletion({ override: [htCompletions] }),
        lintGutter(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        theme,
        label.current.of(EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Strategy code' })),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
  }

  // Another file: new document.
  const shownKey = useRef(docKey);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (shownKey.current !== docKey) {
      shownKey.current = docKey;
      v.setState(makeState(value));
    } else if (v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const marks: CmDiagnostic[] = diagnostics.map((d) => {
      const line = doc.line(Math.min(doc.lines, Math.max(1, d.line)));
      const from = Math.min(line.to, line.from + Math.max(0, d.column));
      return {
        from,
        to: Math.max(from, line.to),
        severity: d.severity,
        message: d.message,
      };
    });
    v.dispatch(setDiagnostics(v.state, marks));
  }, [diagnostics, docKey, value]);

  return <div ref={host} className="hte-code" data-testid="ht-editor-code" />;
}
