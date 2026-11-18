import { useEffect, useState } from 'react';
import { Copy, Download, Plus, Trash2, Upload } from 'lucide-react';
import { Button, Checkbox, Input, NumberInput, Select, toast } from '@htflow/ui-kit';
import {
  ATM_SL_TYPES,
  ATM_TP_UNITS,
  describeAtm,
  validateAtm,
  type AtmSlType,
  type AtmTemplate,
  type AtmTpUnit,
} from '@htflow/trading';
import {
  addTemplate,
  deleteTemplate,
  exportTemplates,
  importTemplates,
  saveTemplate,
  useAtmTemplates,
} from '../../trading/atmStore';
import { setPrefs, useTradingPrefs } from '../../trading/prefs';

import { translateLiteral as tl } from '@htflow/i18n';
function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f || f.size > 2 * 1024 * 1024) return resolve(null);
      void f.text().then(resolve);
    };
    input.click();
  });
}

/** ATM template editor (P17): list with presets on the left, form on the right. */
export function AtmEditor() {
  const templates = useAtmTemplates();
  const prefs = useTradingPrefs();
  const [selId, setSelId] = useState<string>(templates[0]?.id ?? '');
  const sel = templates.find((t) => t.id === selId) ?? templates[0];
  const [draft, setDraft] = useState<AtmTemplate | null>(sel ? structuredClone(sel) : null);
  useEffect(() => {
    setDraft(sel ? structuredClone(sel) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id]);
  const errors = draft ? validateAtm(draft) : [];
  const dirty = !!draft && !!sel && JSON.stringify(draft) !== JSON.stringify(sel);
  const ro = !!draft?.builtin;
  const set = (patch: Partial<AtmTemplate>) => draft && setDraft({ ...draft, ...patch });

  const unitLabel = (u: string) =>
    u === 'ticks' ? 'T' : u === 'points' ? 'pt' : u === 'usd' ? '$' : u === 'percent' ? '%' : 'ATR';

  return (
    <div className="atm-editor" data-testid="atm-editor">
      <div className="atm-list">
        <div className="row gap6 atm-list-tools">
          <Button
            size="sm"
            onClick={() => setSelId(addTemplate().id)}
            aria-label={tl('New template')}
          >
            <Plus size={12} /> {tl('New')}
          </Button>
          <Button
            size="sm"
            disabled={!sel}
            onClick={() => sel && setSelId(addTemplate(sel).id)}
            aria-label={tl('Duplicate template')}
            title={tl('Duplicate')}
          >
            <Copy size={12} />
          </Button>
          <Button
            size="sm"
            title={tl('Export my templates (JSON)')}
            aria-label={tl('Export templates')}
            onClick={() => download('htflow-atm-templates.json', exportTemplates())}
          >
            <Download size={12} />
          </Button>
          <Button
            size="sm"
            title={tl('Import templates (JSON)')}
            aria-label={tl('Import templates')}
            onClick={() =>
              void pickFile().then((txt) => {
                if (!txt) return;
                try {
                  toast('success', `Imported ${importTemplates(txt)} template(s)`);
                } catch {
                  toast('error', tl('Import failed'), tl('Not a template file'));
                }
              })
            }
          >
            <Upload size={12} />
          </Button>
        </div>
        {templates.map((t) => (
          <button
            key={t.id}
            className="atm-item"
            aria-pressed={t.id === sel?.id}
            onClick={() => setSelId(t.id)}
          >
            <span className="row gap6 center-y">
              <b>{t.name}</b>
              {t.builtin && <span className="ot-badge">{tl('Preset')}</span>}
              {prefs.atmId === t.id && <span className="ot-badge">{tl('In use')}</span>}
            </span>
            <span className="muted tnum">{describeAtm(t)}</span>
          </button>
        ))}
      </div>
      {draft && (
        <div className="atm-form">
          <fieldset disabled={ro} className="atm-fieldset">
            <label className="atm-row">
              <span>{tl('Name')}</span>
              <Input
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                aria-label={tl('Template name')}
              />
            </label>

            <h4>{tl('Stop loss')}</h4>
            <div className="atm-row">
              <Checkbox
                checked={draft.sl.enabled}
                onChange={(v) => set({ sl: { ...draft.sl, enabled: v } })}
                label={tl('Protective stop')}
              />
            </div>
            <div className="atm-row">
              <span>{tl('Type')}</span>
              <Select
                small
                value={draft.sl.type}
                onChange={(v: AtmSlType) => set({ sl: { ...draft.sl, type: v } })}
                options={ATM_SL_TYPES}
                aria-label={tl('Stop type')}
              />
            </div>
            <div className="atm-row">
              <span>{tl('Distance')}</span>
              <div className="row gap6">
                <NumberInput
                  value={draft.sl.value}
                  onChange={(v) => set({ sl: { ...draft.sl, value: v } })}
                  step={draft.sl.type === 'ticks' || draft.sl.type === 'trailing' ? 1 : 0.1}
                  min={0}
                  unit={unitLabel(
                    draft.sl.type === 'trailing' ? draft.sl.trailUnit : draft.sl.type,
                  )}
                  aria-label={tl('Stop distance')}
                />
                {draft.sl.type === 'trailing' && (
                  <Select
                    small
                    value={draft.sl.trailUnit}
                    onChange={(v) => set({ sl: { ...draft.sl, trailUnit: v } })}
                    options={[
                      { value: 'ticks', label: 'Ticks' },
                      { value: 'percent', label: '%' },
                      { value: 'atr', label: 'ATR ×' },
                    ]}
                    aria-label={tl('Trailing unit')}
                  />
                )}
              </div>
            </div>
            <div className="atm-row">
              <span>{tl('ATR period')}</span>
              <NumberInput
                value={draft.atrPeriod}
                onChange={(v) => set({ atrPeriod: v })}
                min={2}
                max={500}
                unit="bars"
                aria-label={tl('ATR period')}
              />
            </div>

            <h4>{tl('Targets')}</h4>
            <div className="atm-row">
              <span>{tl('Unit')}</span>
              <Select
                small
                value={draft.tpUnit}
                onChange={(v: AtmTpUnit) => set({ tpUnit: v })}
                options={ATM_TP_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                aria-label={tl('Target unit')}
              />
            </div>
            {draft.targets.map((tg, i) => (
              <div className="atm-row" key={i}>
                <span>
                  {tl('TP')} {i + 1}
                </span>
                <div className="row gap6 center-y">
                  <NumberInput
                    value={tg.value}
                    onChange={(v) =>
                      set({
                        targets: draft.targets.map((x, j) => (j === i ? { ...x, value: v } : x)),
                      })
                    }
                    step={draft.tpUnit === 'ticks' ? 1 : 0.05}
                    min={0}
                    unit={unitLabel(draft.tpUnit)}
                    aria-label={`Target ${i + 1} distance`}
                  />
                  <NumberInput
                    value={tg.qty}
                    onChange={(v) =>
                      set({
                        targets: draft.targets.map((x, j) => (j === i ? { ...x, qty: v } : x)),
                      })
                    }
                    min={0}
                    unit="share"
                    aria-label={`Target ${i + 1} quantity share`}
                  />
                  <button
                    className="ot-x"
                    aria-label={`Remove target ${i + 1}`}
                    onClick={() => set({ targets: draft.targets.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <div className="atm-row">
              <span />
              <Button
                size="sm"
                disabled={draft.targets.length >= 8}
                onClick={() =>
                  set({
                    targets: [
                      ...draft.targets,
                      { value: (draft.targets.at(-1)?.value ?? 5) * 2, qty: 1 },
                    ],
                  })
                }
              >
                <Plus size={12} /> {tl('Add target')}
              </Button>
            </div>

            <h4>{tl('Auto-breakeven')}</h4>
            <div className="atm-row">
              <Checkbox
                checked={draft.breakeven.enabled}
                onChange={(v) => set({ breakeven: { ...draft.breakeven, enabled: v } })}
                label={tl('Move stop to breakeven')}
              />
            </div>
            <div className="atm-row">
              <span>{tl('At profit')}</span>
              <NumberInput
                value={draft.breakeven.trigger}
                onChange={(v) => set({ breakeven: { ...draft.breakeven, trigger: v } })}
                min={1}
                unit="T"
                aria-label={tl('Breakeven trigger')}
              />
            </div>
            <div className="atm-row">
              <span>{tl('Plus')}</span>
              <NumberInput
                value={draft.breakeven.offset}
                onChange={(v) => set({ breakeven: { ...draft.breakeven, offset: v } })}
                min={-100}
                unit="T"
                aria-label={tl('Breakeven offset')}
              />
            </div>

            <h4>{tl('Trailing steps')}</h4>
            {draft.trailSteps.map((s, i) => (
              <div className="atm-row" key={i}>
                <span>
                  {tl('Step')} {i + 1}
                </span>
                <div className="row gap6 center-y">
                  <NumberInput
                    value={s.trigger}
                    onChange={(v) =>
                      set({
                        trailSteps: draft.trailSteps.map((x, j) =>
                          j === i ? { ...x, trigger: v } : x,
                        ),
                      })
                    }
                    min={1}
                    unit="T profit"
                    aria-label={`Step ${i + 1} trigger`}
                  />
                  <NumberInput
                    value={s.stopOffset}
                    onChange={(v) =>
                      set({
                        trailSteps: draft.trailSteps.map((x, j) =>
                          j === i ? { ...x, stopOffset: v } : x,
                        ),
                      })
                    }
                    min={-1000}
                    unit="T stop"
                    aria-label={`Step ${i + 1} stop`}
                  />
                  <button
                    className="ot-x"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => set({ trailSteps: draft.trailSteps.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <div className="atm-row">
              <span />
              <Button
                size="sm"
                onClick={() => {
                  const last = draft.trailSteps.at(-1);
                  set({
                    trailSteps: [
                      ...draft.trailSteps,
                      last
                        ? { trigger: last.trigger + 10, stopOffset: last.stopOffset + 10 }
                        : { trigger: 10, stopOffset: 4 },
                    ],
                  });
                }}
              >
                <Plus size={12} /> {tl('Add step')}
              </Button>
            </div>
          </fieldset>

          {errors.length > 0 && (
            <ul className="atm-errors" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="muted tnum atm-summary">{describeAtm(draft)}</div>
          <div className="row gap8 atm-actions">
            {ro ? (
              <span className="muted">{tl('Presets are read-only — duplicate to edit.')}</span>
            ) : (
              <>
                <Button
                  variant="primary"
                  disabled={!dirty || errors.length > 0}
                  onClick={() => {
                    saveTemplate(draft);
                    toast('success', tl('Template saved'), draft.name);
                  }}
                >
                  {tl('Save')}
                </Button>
                <Button disabled={!dirty} onClick={() => sel && setDraft(structuredClone(sel))}>
                  {tl('Revert')}
                </Button>
                <span className="grow" />
                <Button
                  aria-label={tl('Delete template')}
                  onClick={() => {
                    deleteTemplate(draft.id);
                    if (prefs.atmId === draft.id) setPrefs({ atmId: '' });
                    setSelId(templates[0]?.id ?? '');
                  }}
                >
                  <Trash2 size={12} /> {tl('Delete')}
                </Button>
              </>
            )}
            <Button
              disabled={dirty}
              onClick={() => setPrefs({ atmId: draft.id, bracketOn: true })}
              data-testid="atm-use"
            >
              {tl('Use in Trading Panel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
