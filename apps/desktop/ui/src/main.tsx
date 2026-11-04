import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview/dist/styles/dockview.css';
import { applyTheme } from '@htflow/ui-kit';
import './styles/app.css';
import { App } from './App';

applyTheme('dark');

// Block the WebView's native context menu everywhere except inputs (we draw our own menus).
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
