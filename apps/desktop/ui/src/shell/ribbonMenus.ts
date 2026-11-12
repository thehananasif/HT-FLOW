import type { ComponentType, ReactElement } from 'react';

/**
 * Ribbon buttons with a ▾ menu (`hasMenu`). A module registers a component that wraps the button
 * (`trigger`) in its own dropdown, so the menu can use hooks and stay live. Without a registered
 * menu the button simply opens the module.
 */
export type RibbonMenu = ComponentType<{ trigger: ReactElement }>;

const menus = new Map<string, RibbonMenu>();

export function registerRibbonMenu(moduleId: string, menu: RibbonMenu): void {
  menus.set(moduleId, menu);
}

export function ribbonMenu(moduleId: string): RibbonMenu | undefined {
  return menus.get(moduleId);
}
