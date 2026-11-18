import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_FORMULA, SCRIPT_BUILTINS, previewFormula } from '@htflow/indicator-sdk';
import { Button, Dialog, Input } from '@htflow/ui-kit';
import { contexts } from './state';

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
        aria-label="Formula"
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
              <th>Bar</th>
              <th>Value</th>
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
        <b>Values</b> {SCRIPT_BUILTINS.variables.join(' ')} · <code>x[n]</code> or{' '}
        <code>ref(x, n)</code> = n bars ago
        <br />
        <b>Functions</b> {SCRIPT_BUILTINS.functions.join(' ')}
        <br />
        <b>Operators</b> <code>+ - * / % ^ &lt; &gt; == != and or not ?:</code> · up to{' '}
        {MAX_FORMULA} characters. Formulas are sandboxed: only bar values and the functions above.
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
        aria-label="Edit formula"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        <Pencil size={12} /> Edit
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={setOpen}
          title="Custom Formula"
          description="Type an expression; it is checked and previewed on the chart's last bars as you type."
          width={620}
        >
          <EditorBody windowId={windowId} text={draft} setText={setDraft} />
          <div className="fe-actions">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
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
              Apply
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
