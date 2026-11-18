/** Templates tab of Chart settings (P09 / P34): active template, defaults per class, my templates. */
import { useState } from 'react';
import { Copy, Download, Pencil, Star, Trash2, Upload } from 'lucide-react';
import { Button, Checkbox, Input, Select, toast } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { CHART_TEMPLATES } from '@htflow/workspace';
import { extState } from '../../charts/settings/state';
import {
  applyTemplateTo,
  downloadText,
  pickTextFile,
  saveTemplateFrom,
  useChartTemplates,
} from '../../charts/templateStore';
import {
  allTemplates,
  ASSET_CLASSES,
  deleteTemplate,
  duplicateTemplate,
  importTemplates,
  parseTemplatesFile,
  renameTemplate,
  serializeTemplates,
  setClassDefault,
  TEMPLATE_EXT,
  toggleFavourite,
  updateTemplate,
  type UserChartTemplate,
} from '../../charts/templates';

import { translateLiteral as tl, tt } from '@htflow/i18n';
export function TemplatesTab({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  const lib = useChartTemplates((s) => s.lib);
  const update = useChartTemplates((s) => s.update);
  const all = allTemplates(lib);
  const activeId = extState(state).templateId;
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const builtIn = CHART_TEMPLATES.find((t) => t.id === state.template)?.label ?? state.template;
  const active = all.find((t) => t.id === activeId);

  const doImport = async () => {
    const text = await pickTextFile(`${TEMPLATE_EXT},.json,application/json`);
    if (!text) return;
    const { templates, errors } = parseTemplatesFile(text);
    if (templates.length) {
      update((l) => importTemplates(l, templates));
      toast('success', tt`Imported ${templates.length} template${templates.length > 1 ? 's' : ''}`);
    }
    if (errors.length) toast('error', tl('Some templates were skipped'), errors.join('\n'));
  };

  const row = (t: UserChartTemplate) => (
    <div
      key={t.id}
      className={`cs-tpl${t.id === activeId ? ' cs-tpl--active' : ''}`}
      data-testid={`template-${t.name}`}
    >
      <button
        className="ht-icon-btn"
        aria-label={t.favourite ? `Unstar ${t.name}` : `Star ${t.name}`}
        aria-pressed={t.favourite}
        onClick={() => update((l) => toggleFavourite(l, t.id))}
      >
        <Star size={12} fill={t.favourite ? 'currentColor' : 'none'} />
      </button>
      {renaming === t.id ? (
        <form
          className="grow"
          onSubmit={(e) => {
            e.preventDefault();
            update((l) => renameTemplate(l, t.id, renameText));
            setRenaming(null);
          }}
        >
          <Input
            autoFocus
            aria-label={tl('New template name')}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={() => setRenaming(null)}
          />
        </form>
      ) : (
        <span className="cs-tpl-name grow">
          {t.name}
          <span className="muted">
            {' '}
            · {CHART_TEMPLATES.find((c) => c.id === t.state.template)?.short}
            {t.preset
              ? ' · style preset'
              : ` · edited ${new Date(t.updatedAt).toLocaleDateString()}`}
          </span>
        </span>
      )}
      <Button size="xs" variant="outline" onClick={() => applyTemplateTo(windowId, t.id)}>
        {tl('Load')}
      </Button>
      {!t.preset && (
        <button
          className="ht-icon-btn"
          aria-label={tt`Overwrite ${t.name} with this chart`}
          title={tl('Save this chart over the template')}
          onClick={() => {
            update((l) => updateTemplate(l, t.id, state));
            toast('success', tt`Template “${t.name}” updated`);
          }}
        >
          <Upload size={12} />
        </button>
      )}
      {!t.preset && (
        <button
          className="ht-icon-btn"
          aria-label={tt`Rename ${t.name}`}
          onClick={() => {
            setRenaming(t.id);
            setRenameText(t.name);
          }}
        >
          <Pencil size={12} />
        </button>
      )}
      <button
        className="ht-icon-btn"
        aria-label={tt`Duplicate ${t.name}`}
        onClick={() => update((l) => duplicateTemplate(l, t.id))}
      >
        <Copy size={12} />
      </button>
      <button
        className="ht-icon-btn"
        aria-label={tt`Export ${t.name}`}
        onClick={() =>
          downloadText(
            `${t.name.replace(/[^\w.-]+/g, '_')}${TEMPLATE_EXT}`,
            serializeTemplates([t]),
          )
        }
      >
        <Download size={12} />
      </button>
      {!t.preset && (
        <button
          className="ht-icon-btn"
          aria-label={tt`Delete ${t.name}`}
          onClick={() => {
            if (window.confirm(`Delete template “${t.name}”?`))
              update((l) => deleteTemplate(l, t.id));
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );

  const options = [
    { value: '', label: '— none —' },
    ...all.map((t) => ({ value: t.id, label: t.name })),
  ];

  return (
    <div className="cs-templates">
      <section className="cs-section">
        <div className="cs-sec-head cs-sec-static">{tl('Current chart')}</div>
        <div className="cs-grid">
          <div className="cs-row">
            <span className="cs-name">{tl('Active template')}</span>
            <span className="cs-editor">{active ? active.name : `${builtIn} (built-in)`}</span>
          </div>
          <div className="cs-row">
            <span className="cs-name">{tl('Apply template on instrument change')}</span>
            <span className="cs-editor">
              <Checkbox
                checked={lib.applyOnInstrumentChange}
                onChange={(v) => update((l) => ({ ...l, applyOnInstrumentChange: v }))}
                label={tl('Use the class default')}
              />
            </span>
          </div>
          {ASSET_CLASSES.map((c) => (
            <div className="cs-row" key={c.value}>
              <span className="cs-name">
                {tl('Default for')} {c.label.toLowerCase()}
              </span>
              <span className="cs-editor">
                <Select
                  small
                  aria-label={tt`Default template for ${c.label}`}
                  value={lib.defaults[c.value] ?? ''}
                  options={options}
                  onChange={(v) => update((l) => setClassDefault(l, c.value, v || null))}
                />
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="cs-section">
        <div className="cs-sec-head cs-sec-static">
          {tl('My templates')} <span className="cs-count">{lib.templates.length}</span>
        </div>
        <form
          className="cs-tpl-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            saveTemplateFrom(windowId, newName.trim());
            setNewName('');
          }}
        >
          <Input
            aria-label={tl('New template name')}
            placeholder={tl('Save current chart as…')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!newName.trim()}>
            {tl('Save as')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void doImport()}>
            {tl('Import')} {TEMPLATE_EXT}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!lib.templates.length}
            onClick={() =>
              downloadText(`htflow-templates${TEMPLATE_EXT}`, serializeTemplates(lib.templates))
            }
          >
            {tl('Export all')}
          </Button>
        </form>
        {lib.templates.length === 0 && (
          <p className="muted cs-empty">
            {tl('No templates yet. Save the current chart as a template above.')}
          </p>
        )}
        {lib.templates.map(row)}
      </section>
      <section className="cs-section">
        <div className="cs-sec-head cs-sec-static">{tl('Style presets')}</div>
        {all.filter((t) => t.preset).map(row)}
      </section>
    </div>
  );
}
