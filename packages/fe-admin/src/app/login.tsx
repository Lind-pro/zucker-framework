import { KeyRound, Lock, Mail, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { isSafeRelativeRedirect, loginIdentifierInput } from '@zucker-framework/fe-auth';
import { Button } from '../components/button';
import { Notice, toast } from '../components/feedback';
import { Field, Input } from '../components/inputs';
import { useAdminI18n } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';
import type { LoginIdentifier } from '@zucker-framework/fe-auth';
import { useAdmin } from './context';
import { LanguageSwitcher } from './layout';
import { AdminTwoFactorRequiredError } from './session';

/** Second-step state after `{ twoFactorRequired, challenge }`; the challenge stays in memory only. */
interface TwoFactorStep {
  challenge: string;
  mode: 'code' | 'recovery';
}

/** Trimmed, space-free factor; `null` when it cannot be valid (a 6–8 digit code, or a recovery code). */
export function twoFactorInput(mode: TwoFactorStep['mode'], value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  if (mode === 'code') return /^\d{6,8}$/.test(compact) ? compact : null;
  return /^[A-Za-z0-9-]{10,32}$/.test(compact) ? compact : null;
}

const IDENTIFIER_LABELS = {
  username: 'shell.username', email: 'shell.email', 'username-or-email': 'shell.usernameOrEmail',
} as const satisfies Record<LoginIdentifier, AdminMessageKey>;
const IDENTIFIER_SUBTITLES = {
  username: 'shell.loginSubtitle', email: 'shell.loginSubtitleEmail', 'username-or-email': 'shell.loginSubtitleUsernameOrEmail',
} as const satisfies Record<LoginIdentifier, AdminMessageKey>;

/** Sign in through the account module (`POST /authorize/login`, then `GET /authorize/me`). */
/**
 * Post-login target: a same-app path only. On top of the shared fe-auth check, any control
 * character is rejected because URL parsers strip tabs/newlines (`/\t/evil.com` → `//evil.com`).
 */
export function isAdminRedirect(requested: string): boolean {
  if (!requested || /[\u0000-\u001f\u007f]/.test(requested)) return false;
  return isSafeRelativeRedirect(requested) && !requested.startsWith('/login');
}

export function LoginPage() {
  const { session, config } = useAdmin();
  const { t } = useAdminI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isAuthenticated = session.store((state) => state.isAuthenticated);
  const token = session.store((state) => state.token);
  const [username, setUsername] = useState('');
  // Label, input type and request field follow the server's `login.identifier` option.
  const identifier = loginIdentifierInput(config.loginIdentifier);
  const identifierLabel = t(IDENTIFIER_LABELS[config.loginIdentifier]);
  const IdentifierIcon = config.loginIdentifier === 'email' ? Mail : User;
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<TwoFactorStep | null>(null);
  const [factor, setFactor] = useState('');
  const [factorError, setFactorError] = useState<string | undefined>();
  const requested = params.get('redirect') ?? '';
  const destination = isAdminRedirect(requested) ? requested : config.homePath;
  if (isAuthenticated && token && !submitting) return <Navigate to={destination} replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      username: username.trim() ? undefined : t('common.required', { label: identifierLabel }),
      password: password ? undefined : t('common.required', { label: t('shell.password') }),
    };
    setErrors(next);
    if (next.username || next.password) return;
    setSubmitting(true);
    setFailed(false);
    try {
      await session.login(username.trim(), password);
      toast.success(t('shell.loginSucceeded'));
      navigate(destination, { replace: true });
    } catch (error) {
      setPassword('');
      if (error instanceof AdminTwoFactorRequiredError) {
        setStep({ challenge: error.challenge, mode: 'code' });
        setFactor('');
        setFactorError(undefined);
      } else {
        setFailed(true);
      }
    } finally {
      setSubmitting(false);
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!step) return;
    const label = step.mode === 'code' ? t('shell.twoFactorCode') : t('shell.recoveryCode');
    const value = twoFactorInput(step.mode, factor);
    if (!value) {
      setFactorError(t('common.required', { label }));
      return;
    }
    setFactorError(undefined);
    setSubmitting(true);
    setFailed(false);
    try {
      await session.loginTwoFactor(step.challenge, step.mode === 'code' ? { code: value } : { recoveryCode: value });
      toast.success(t('shell.loginSucceeded'));
      navigate(destination, { replace: true });
    } catch {
      // A wrong code keeps the challenge (the server does not consume it); an expired one needs "back".
      setFailed(true);
      setFactor('');
    } finally {
      setSubmitting(false);
    }
  }
  function backToPassword() {
    setStep(null);
    setFactor('');
    setFactorError(undefined);
    setFailed(false);
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-6 shadow-sm">
        <div className="space-y-1 text-center">
          {config.logo && <div className="mb-3 flex justify-center">{config.logo}</div>}
          <h1 className="text-xl font-semibold">{config.brandName ?? t('shell.loginTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {step ? t(step.mode === 'code' ? 'shell.twoFactorSubtitle' : 'shell.recoverySubtitle') : t(IDENTIFIER_SUBTITLES[config.loginIdentifier])}
          </p>
        </div>
        {failed && <Notice tone="danger" title={t(step ? 'shell.twoFactorFailed' : 'shell.loginFailed')} />}
        {step ? (
          <form noValidate onSubmit={(event) => void verify(event)} className="space-y-4" aria-label={t('shell.twoFactorTitle')}>
            <Field label={step.mode === 'code' ? t('shell.twoFactorCode') : t('shell.recoveryCode')} error={factorError} required>
              {({ id, describedBy, invalid }) => (
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    key={step.mode}
                    id={id}
                    name={step.mode === 'code' ? 'code' : 'recoveryCode'}
                    autoComplete="one-time-code"
                    inputMode={step.mode === 'code' ? 'numeric' : 'text'}
                    autoFocus
                    className="h-10 pl-9"
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={factor}
                    onChange={(event) => setFactor(event.target.value)}
                  />
                </div>
              )}
            </Field>
            <Button type="submit" variant="primary" className="h-10 w-full" loading={submitting}>
              {submitting ? t('shell.loggingIn') : t('shell.twoFactorVerify')}
            </Button>
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setStep({ ...step, mode: step.mode === 'code' ? 'recovery' : 'code' });
                  setFactor('');
                  setFactorError(undefined);
                  setFailed(false);
                }}
              >
                {step.mode === 'code' ? t('shell.useRecoveryCode') : t('shell.useAuthenticatorCode')}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={backToPassword}>
                {t('shell.twoFactorBack')}
              </Button>
            </div>
          </form>
        ) : (
          <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4" aria-label={t('shell.login')}>
            <Field label={identifierLabel} error={errors.username} required>
              {({ id, describedBy, invalid }) => (
                <div className="relative">
                  <IdentifierIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id={id}
                    name={identifier.field}
                    type={identifier.type}
                    inputMode={identifier.inputMode}
                    autoComplete={identifier.autoComplete}
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                    className="h-10 pl-9"
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>
              )}
            </Field>
            <Field label={t('shell.password')} error={errors.password} required>
              {({ id, describedBy, invalid }) => (
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id={id}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    className="h-10 pl-9"
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              )}
            </Field>
            <Button type="submit" variant="primary" className="h-10 w-full" loading={submitting}>
              {submitting ? t('shell.loggingIn') : t('shell.login')}
            </Button>
            {config.loginForgotPasswordHref && (
              <p className="text-center text-sm">
                <a className="text-primary underline-offset-4 hover:underline" href={config.loginForgotPasswordHref}>
                  {t('shell.forgotPassword')}
                </a>
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
