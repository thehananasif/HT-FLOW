import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '@htflow/dom';
import { STATIC_DEFAULTS, setSetting, useSettingsStore } from '../../state/settings';
import { effectiveTemplate } from '../DomView';
import { clickSide, defaultGrouping, newDomState } from './globalSettings';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('Settings → DOM', () => {
  it('swap left / right click', () => {
    expect(clickSide('left', false)).toBe('buy');
    expect(clickSide('right', false)).toBe('sell');
    expect(clickSide('left', true)).toBe('sell');
    expect(clickSide('right', true)).toBe('buy');
  });
  it('default grouping applies to new DOM windows', () => {
    expect(newDomState('mock:ESZ6').grouping).toBe(1);
    setSetting('dom.defaultGrouping', '5');
    expect(defaultGrouping()).toBe(5);
    expect(newDomState('mock:ESZ6')).toMatchObject({ kind: 'dom', grouping: 5 });
  });
  it('font size and recent window override the template', () => {
    const t = BUILTIN_TEMPLATES[0]!;
    const same = effectiveTemplate(t, STATIC_DEFAULTS);
    expect(same.behaviour.recentSeconds).toBe(t.behaviour.recentSeconds);
    const v = { ...STATIC_DEFAULTS, 'dom.fontSize': 15, 'dom.recentWindowSec': 60 };
    const e = effectiveTemplate(t, v);
    expect(e.style.fontSize).toBe(15);
    expect(e.behaviour.recentSeconds).toBe(60);
  });
});
