import { onSettingChange } from '../state/settings';

const KEY = 'htflow.loginAnimation';

/** The login screen shows before any profile (and so any setting) is loaded: a localStorage mirror carries the choice. */
export function loginAnimationEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setLoginAnimationEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for this run only */
  }
  window.dispatchEvent(new CustomEvent('htflow:login-animation', { detail: on }));
}

/** Keeps the mirror in step with Settings -> Appearance (also when a profile loads). */
onSettingChange('appearance.loginAnimation', (v) => setLoginAnimationEnabled(v));
