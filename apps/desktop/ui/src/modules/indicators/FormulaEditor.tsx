import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_FORMULA, SCRIPT_BUILTINS, previewFormula } from '@htflow/indicator-sdk';
import { Button, Dialog, Input } from '@htflow/ui-kit';
import { contexts } from './state';

import { translateLiteral as tl } from '@htflow/i18n';
const EXAMPLES = [
  '(close - sma(close, 20)) / stdev(close, 20)',
  'ema(delta, 10) - ema(delta, 30)',
  'iff(close > ref(close, 1), buyVol, -sellVol)',
  'highest(high, 20) - lowest(low, 20)',
];

const fmt = (v: number) =>
  Number.isNaN(v)
    ? 'n/a'
    : Math.abs(v) >= 1000
      ? v.toFixed(1)
      : Math.abs(v) >= 1
        ? v.toFixed(3)
        : v.toFixed(6);

function EditorBody({
  windowId,
  text,
  setText,
}: {
  windowId: string;
  text: string;
  setText: (v: string) => void;
}) {
  const ctx = contexts.get(windowId);
  const bars = ctx?.series()?.bars;
  const tick = ctx?.store.instrument.tickSize ?? 1;
  const res = useMemo(
    () => (bars ? previewFormula(text, bars, tick, 8) : null),
    // Bars are re-read when the text changes; the preview is a snapshot of the chart's tail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, bars?.length, tick],
  );
  return (
    <div className="fe-body">
      <textarea
        className="fe-text"
        aria-label={tl('Formula')}
        data-testid="formula-text"
        spellCheck={false}
        maxLength={MAX_FORMULA}
        value={text}
        rows={4}
        onChange={(e) => setText(e.target.value)}
      />
      <div
        className={`fe-status ${res && !res.ok ? 'fe-status--err' : ''}`}
        role="status"
        data-testid="formula-status"
      >
        {!res ? 'No chart bars to preview on.' : res.ok ? 'Formula OK' : `Error ${res.error}`}
      </div>
      {res?.ok && (
        <table className="fe-preview" data-testid="formula-preview">
          <thead>
            <tr>
              <th>{tl('Bar')}</th>
              <th>{tl('Value')}</th>
            </tr>
          </thead>
          <tbody>
            {res.rows.map((r) => (
              <tr key={r.t}>
                <td>{new Date(r.t).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{fmt(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="fe-ref">
        <b>{tl('Values')}</b> {SCRIPT_BUILTINS.variables.join(' ')} · <code>x[n]</code> {tl('or')}{' '}
        <code>{tl('ref(x, n)')}</code> {tl('= n bars ago')}
        <br />
        <b>{tl('Functions')}</b> {SCRIPT_BUILTINS.functions.join(' ')}
        <br />
        <b>{tl('Operators')}</b> <code>+ - * / % ^ &lt; &gt; == != and or not ?:</code>{' '}
        {tl('· up to')} {MAX_FORMULA}{' '}
        {tl('characters. Formulas are sandboxed: only bar values and the functions above.')}
      </p>
      <div className="fe-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="fe-example" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Custom Formula input: a text field plus an editor dialog with syntax errors and live preview. */
export function FormulaInput({
  windowId,
  label,
  value,
  onChange,
}: {
  windowId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div className="fe-input">
      <Input
        aria-label={label}
        value={value}
        maxLength={MAX_FORMULA}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        data-testid="formula-edit"
        aria-label={tl('Edit formula')}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <Pencil size={12} /> {tl('Edit')}
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={setOpen}
          title={tl('Custom Formula')}
          description={tl(
            "Type an expression; it is checked and previewed on the chart's last bars as you type.",
          )}
          width={620}
        >
          <EditorBody windowId={windowId} text={draft} setText={setDraft} />
          <div className="fe-actions">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {tl('Cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="formula-apply"
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              {tl('Apply')}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
