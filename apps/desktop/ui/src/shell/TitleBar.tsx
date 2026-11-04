import type { ReactNode } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { LogoBars } from '@htflow/ui-kit';
import { backend } from '../backend';

/** Custom, draggable title bar (Tauri: decorations off, data-tauri-drag-region). */
export function TitleBar({ minimal, children }: { minimal?: boolean; children?: ReactNode }) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      {minimal ? (
        <div className="titlebar-brand" data-tauri-drag-region>
          <LogoBars size={16} />
          <span>HT Flow</span>
        </div>
      ) : (
        children
      )}
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className="win-controls">
        <button aria-label="Minimize" onClick={() => backend.window.minimize()}>
          <Minus size={15} />
        </button>
        <button aria-label="Maximize" onClick={() => backend.window.toggleMaximize()}>
          <Square size={12} />
        </button>
        <button aria-label="Close" className="win-close" onClick={() => backend.window.close()}>
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
