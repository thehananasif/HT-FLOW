import { describe, expect, it } from 'vitest';
import { t, type Strings } from '@htflow/i18n';
import { TOOLS, TOOL_GROUPS } from '@htflow/drawings';
import { menuGroupLabel, toolLabel, toolNote } from './toolText';

describe('drawing tool text', () => {
  it('has a translated name for every tool and the English text is unchanged', () => {
    for (const def of TOOLS) {
      const key = `drawings.tool.${def.id}` as keyof Strings;
      expect(t(key), key).not.toBe(key);
      expect(toolLabel(def.id)).toBe(def.label);
    }
  });

  it('has a description key for every tool that carries a note', () => {
    for (const def of TOOLS.filter((d) => d.note)) {
      expect(toolNote(def.id)).toBe(def.note);
    }
    expect(toolNote('trend-line')).toBeUndefined();
  });

  it('translates the Objects menu group labels', () => {
    for (const g of TOOL_GROUPS) {
      expect(menuGroupLabel(g.id, g.label)).toBe(g.label);
    }
  });

  it('falls back to the package label for an unknown tool id', () => {
    expect(toolLabel('no-such-tool')).toBe('no-such-tool');
  });
});
