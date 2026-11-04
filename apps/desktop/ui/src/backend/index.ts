import { createTauriBackend } from './tauri';
import { createWebBackend } from './web';
import type { Backend } from './types';

export * from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const backend: Backend = isTauri ? createTauriBackend() : createWebBackend();
