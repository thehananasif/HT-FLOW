import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { t } from '@htflow/i18n';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  LogoMark,
  SegmentedControl,
  Select,
  toast,
  type ThemeName,
} from '@htflow/ui-kit';
import { backend, BackendError, type ProfileSummary } from '../backend';
import { useSession } from '../state/session';
import { passwordStrength } from './strength';
import { TitleBar } from '../shell/TitleBar';

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      'timeZone',
    );
  } catch {
    return [
      'UTC',
      'Asia/Karachi',
      'Europe/London',
      'America/New_York',
      'America/Chicago',
      'Asia/Tokyo',
    ];
  }
})();

const errMsg = (e: unknown) =>
  e instanceof BackendError ? e.message : e instanceof Error ? e.message : String(e);

/** Decorative footprint wall for the hero (original artwork, seeded so it never flickers). */
function HeroFootprint() {
  const cols = useMemo(() => {
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: 9 }, (_, c) => ({
      top: 20 + Math.floor(rnd() * 140),
      cells: Array.from({ length: 8 + Math.floor(rnd() * 9) }, () => ({
        a: Math.floor(rnd() * 900) + 10,
        b: Math.floor(rnd() * 900) + 10,
        tone: rnd(),
        c,
      })),
    }));
  }, []);
  return (
    <div className="hero-fp" aria-hidden="true">
      {cols.map((col, i) => (
        <div key={i} className="hero-fp-col" style={{ marginTop: col.top }}>
          {col.cells.map((cell, k) => (
            <div
              key={k}
              className="hero-fp-cell"
              data-tone={cell.tone < 0.22 ? 'up' : cell.tone > 0.8 ? 'down' : 'flat'}
            >
              <span>{cell.a}</span>
              <span>{cell.b}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RecoveryDialog({ words, onDone }: { words: string[]; onDone: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={() => {}}
      title={t('recovery.title')}
      description={t('recovery.body')}
      width={560}
    >
      <ol className="recovery-grid mono" data-testid="recovery-code">
        {words.map((w, i) => (
          <li key={i}>
            <span>{i + 1}</span> {w}
          </li>
        ))}
      </ol>
      <div className="row gap8" style={{ marginTop: 14 }}>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(words.join(' '));
            toast('success', 'Recovery code copied');
          }}
        >
          Copy
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <div style={{ marginTop: 16 }}>
        <Checkbox checked={ok} onChange={setOk} label={t('recovery.confirm')} />
      </div>
      <Button
        variant="primary"
        block
        size="lg"
        style={{ marginTop: 16 }}
        disabled={!ok}
        onClick={onDone}
      >
        Continue
      </Button>
    </Dialog>
  );
}

export function LoginScreen() {
  const setSession = useSession((s) => s.setSession);
  const lastUser = useSession((s) => s.lastUser);
  const [tab, setTab] = useState<'login' | 'create'>('login');
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [username, setUsername] = useState(lastUser ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [recovery, setRecovery] = useState<{
    words: string[];
    session: Parameters<typeof setSession>[0];
  } | null>(null);
  const [version, setVersion] = useState('');

  const refresh = () => void backend.listProfiles().then(setProfiles);
  useEffect(() => {
    refresh();
    void backend.appVersion().then(setVersion);
    void backend.autoLogin().then((s) => s && setSession(s));
  }, [setSession]);
  useEffect(() => {
    if (!username && profiles.length) setUsername(profiles[0]!.username);
    if (!profiles.length) setTab((x) => (x === 'login' && profiles.length === 0 ? 'login' : x));
  }, [profiles, username]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await backend.login(username.trim(), password, remember));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.htprofile,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const p = await backend.importProfile(await f.text());
        toast('success', 'Profile imported', p.username);
        setUsername(p.username);
        refresh();
      } catch (err) {
        toast('error', 'Import failed', errMsg(err));
      }
    };
    inp.click();
  }

  return (
    <div className="login-root">
      <TitleBar minimal />
      <div className="login-body">
        <section className="login-hero">
          <div className="row gap12 center-y">
            <LogoMark size={44} />
            <div>
              <div className="login-brand">HT FLOW</div>
              <div className="login-brand-sub">{t('app.tagline')}</div>
            </div>
          </div>
          <HeroFootprint />
          <div className="login-hero-copy">
            <h1>{t('login.hero')}</h1>
            <p>{t('login.heroSub')}</p>
            <div className="row gap8 wrap">
              {[
                'Footprint & clusters',
                'Liquidity map',
                'DOM ladder',
                'Paper trading',
                'Local encrypted profile',
              ].map((c) => (
                <span key={c} className="login-chip">
                  {c}
                </span>
              ))}
            </div>
          </div>
          <div className="login-foot">
            <span className="ht-dot" data-state="live" /> Your data stays on this PC ·{' '}
            {version && `v${version}`}
          </div>
        </section>
        <section className="login-side">
          <div className="login-card">
            <SegmentedControl
              block
              aria-label="Account"
              value={tab}
              onChange={(v) => {
                setTab(v);
                setError(null);
              }}
              options={[
                { value: 'login', label: t('login.tab.login') },
                { value: 'create', label: t('login.tab.create') },
              ]}
            />
            {tab === 'login' ? (
              <form onSubmit={onLogin} className="col gap16" style={{ marginTop: 24 }}>
                <div>
                  <h2 className="login-h2">{t('login.welcome')}</h2>
                  <p className="login-sub">{t('login.subtitle')}</p>
                </div>
                <Field label={t('login.username')}>
                  <Input
                    large
                    autoFocus
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                  />
                </Field>
                <Field
                  label={t('login.password')}
                  aside={
                    <button type="button" className="link" onClick={() => setForgotOpen(true)}>
                      {t('login.forgot')}
                    </button>
                  }
                  error={error}
                >
                  <Input
                    large
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    invalid={!!error}
                  />
                </Field>
                <Checkbox checked={remember} onChange={setRemember} label={t('login.remember')} />
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  disabled={busy || !username || !password}
                >
                  {busy ? 'Unlocking…' : t('login.submit')}
                </Button>
                <Button variant="outline" size="lg" block onClick={() => setPinOpen(true)}>
                  {t('login.pin')}
                </Button>
                <div className="login-card-foot">
                  <button type="button" className="link" onClick={onImport}>
                    {t('login.import')}
                  </button>
                  <span>{t('login.profiles', { n: profiles.length })}</span>
                </div>
              </form>
            ) : (
              <CreateForm
                onCreated={(r) => {
                  refresh();
                  setRecovery({ words: r.recoveryCode, session: r.session });
                }}
              />
            )}
          </div>
        </section>
      </div>
      {recovery && (
        <RecoveryDialog words={recovery.words} onDone={() => setSession(recovery.session)} />
      )}
      <PinDialog open={pinOpen} onOpenChange={setPinOpen} username={username} />
      <ForgotDialog open={forgotOpen} onOpenChange={setForgotOpen} username={username} />
    </div>
  );
}

function CreateForm({
  onCreated,
}: {
  onCreated: (r: Awaited<ReturnType<typeof backend.createAccount>>) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [theme, setTheme] = useState<ThemeName>('dark');
  const [remember, setRemember] = useState(true);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = passwordStrength(pw);
  const valid =
    displayName.trim() &&
    /^[A-Za-z0-9_.-]{3,32}$/.test(username) &&
    pw.length >= 10 &&
    pw === pw2 &&
    (!pin || /^\d{6}$/.test(pin));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await backend.createAccount({
          displayName: displayName.trim(),
          username,
          email: email || undefined,
          password: pw,
          timezone: tz,
          theme,
          rememberMe: remember,
          pin: pin || undefined,
        }),
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="col gap12 create-form" style={{ marginTop: 20 }}>
      <div>
        <h2 className="login-h2">{t('create.title')}</h2>
        <p className="login-sub">{t('create.subtitle')}</p>
      </div>
      <div className="grid2">
        <Field label={t('create.displayName')}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label={t('login.username')}
          error={
            username && !/^[A-Za-z0-9_.-]{3,32}$/.test(username)
              ? '3–32 letters, digits, . _ -'
              : null
          }
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </Field>
      </div>
      <Field label={t('create.email')}>
        <Input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label={t('login.password')}>
          <Input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field
          label={t('create.confirm')}
          error={pw2 && pw !== pw2 ? 'Passwords do not match' : null}
        >
          <Input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
      </div>
      <div
        className="strength"
        data-score={strength.score}
        aria-label={`Password strength: ${strength.label}`}
      >
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-on={strength.score > i} />
        ))}
        <em>{pw ? strength.label : 'Minimum 10 characters'}</em>
      </div>
      <div className="grid2">
        <Field label={t('create.timezone')}>
          <Select
            value={tz}
            onChange={setTz}
            options={TIMEZONES.map((z) => ({ value: z, label: z }))}
            aria-label="Timezone"
          />
        </Field>
        <Field label={t('create.pin')}>
          <Input
            value={pin}
            inputMode="numeric"
            maxLength={6}
            placeholder="••••••"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </div>
      <Field label={t('create.theme')}>
        <SegmentedControl
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'dark-blue', label: 'Dark Blue' },
            { value: 'gray', label: 'Gray' },
            { value: 'light', label: 'Light' },
            { value: 'high-contrast', label: 'High-Contrast' },
          ]}
        />
      </Field>
      <Checkbox checked={remember} onChange={setRemember} label={t('login.remember')} />
      {error && <div className="ht-error">{error}</div>}
      <Button type="submit" variant="primary" size="lg" block disabled={!valid || busy}>
        {busy ? 'Creating…' : t('create.submit')}
      </Button>
    </form>
  );
}

function PinDialog({
  open,
  onOpenChange,
  username,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  username: string;
}) {
  const setSession = useSession((s) => s.setSession);
  const [user, setUser] = useState(username);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setUser(username), [username]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Unlock with PIN"
      description="Quick unlock for a profile that has a 6-digit PIN."
      width={400}
    >
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setSession(await backend.unlockWithPin(user, pin));
          } catch (x) {
            setErr(errMsg(x));
          }
        }}
      >
        <Field label="Username">
          <Input value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
        <Field label="PIN" error={err}>
          <Input
            large
            inputMode="numeric"
            maxLength={6}
            value={pin}
            autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Button type="submit" variant="primary" block disabled={pin.length !== 6}>
          Unlock
        </Button>
      </form>
    </Dialog>
  );
}

function ForgotDialog({
  open,
  onOpenChange,
  username,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  username: string;
}) {
  const [user, setUser] = useState(username);
  const [words, setWords] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setUser(username), [username]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('forgot.title')}
      description={t('forgot.body')}
      width={520}
    >
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await backend.recover(user, words.trim().toLowerCase().split(/\s+/), pw);
            toast('success', 'Password reset', 'Log in with your new password.');
            onOpenChange(false);
          } catch (x) {
            setErr(errMsg(x));
          }
        }}
      >
        <Field label="Username">
          <Input value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
        <Field label="24-word recovery code">
          <textarea
            className="ht-input mono"
            style={{ height: 90, padding: 10 }}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
        </Field>
        <Field label="New password" error={err}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Button
          type="submit"
          variant="primary"
          block
          disabled={pw.length < 10 || words.trim().split(/\s+/).length !== 24}
        >
          Reset password
        </Button>
      </form>
    </Dialog>
  );
}
