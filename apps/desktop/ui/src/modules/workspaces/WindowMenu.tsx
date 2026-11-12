import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu, IconButton, type MenuEntry } from '@htflow/ui-kit';
import { windowMenuItems } from './windowActions';

/** "⋯" button in every window header: Create linked window ▸, Clone, Link group ▸, Float / Dock. */
export function WindowMenuButton({ id }: { id: string }) {
  // Items are built when the menu opens so they reflect the current state.
  const [items, setItems] = useState<MenuEntry[]>([]);
  return (
    <span
      onPointerDown={() => setItems(windowMenuItems(id))}
      onKeyDown={() => setItems(windowMenuItems(id))}
    >
      <DropdownMenu
        align="end"
        items={items}
        trigger={
          <IconButton label="Window menu" data-testid={`win-menu-${id}`}>
            <MoreHorizontal size={13} />
          </IconButton>
        }
      />
    </span>
  );
}
