export const en = {
  'app.name': 'HT Flow',
  'app.tagline': 'Order flow platform',
  'login.tab.login': 'Login',
  'login.tab.create': 'Create account',
  'login.welcome': 'Welcome back',
  'login.subtitle': 'Log in to your account on this PC.',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.forgot': 'Forgot password?',
  'login.remember': 'Remember me on this PC',
  'login.submit': 'Log in',
  'login.pin': 'Unlock with PIN',
  'login.import': 'Import profile (.htprofile)',
  'login.profiles': 'Profiles on this PC: {n}',
  'login.hero': 'See every trade behind every candle.',
  'login.heroSub':
    'Footprint, heatmap, DOM, tape, TPO and options — on crypto, futures and stocks. Your account and data stay on this PC.',
  'create.title': 'Create your local account',
  'create.subtitle': 'Everything is encrypted and stored only on this PC.',
  'create.displayName': 'Display name',
  'create.email': 'Email (optional, local only)',
  'create.confirm': 'Confirm password',
  'create.timezone': 'Timezone',
  'create.theme': 'Default theme',
  'create.pin': 'Optional 6-digit PIN for quick unlock',
  'create.submit': 'Create account',
  'recovery.title': 'Save your recovery code',
  'recovery.body':
    'This 24-word code is the only way to recover your local data if you forget your password. HT Flow has no server and cannot reset it for you.',
  'recovery.confirm': 'I have saved my recovery code',
  'forgot.title': 'Recover your account',
  'forgot.body':
    'Local data can only be recovered with the 24-word recovery code shown when the account was created.',
  'lock.title': 'HT Flow is locked',
  'status.server': 'Server',
  'status.latency': 'Latency',
  'empty.module.title': '{name}',
  'empty.module.body':
    'This module is part of phase {phase} of the build plan. Its window, ribbon entry and command are registered; the full screen is not built yet (tracked in docs/FEATURES.md).',
} as const;

export type Strings = { [K in keyof typeof en]: string };
