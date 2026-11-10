import { Lock, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { isSafeRelativeRedirect } from '@zucker-framework/fe-auth';
import { Button } from '../components/button';
import { Notice, toast } from '../components/feedback';
import { Field, Input } from '../components/inputs';
import { useAdminI18n } from '../i18n/context';
import { useAdmin } from './context';
import { LanguageSwitcher } from './layout';

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
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requested = params.get('redirect') ?? '';
  const destination = isAdminRedirect(requested) ? requested : config.homePath;
  if (isAuthenticated && token && !submitting) return <Navigate to={destination} replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      username: username.trim() ? undefined : t('common.required', { label: t('shell.username') }),
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
    } catch {
      setFailed(true);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
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
          <p className="text-sm text-muted-foreground">{t('shell.loginSubtitle')}</p>
        </div>
        {failed && <Notice tone="danger" title={t('shell.loginFailed')} />}
        <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4" aria-label={t('shell.login')}>
          <Field label={t('shell.username')} error={errors.username} required>
            {({ id, describedBy, invalid }) => (
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id={id}
                  name="username"
                  autoComplete="username"
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
        </form>
      </div>
    </main>
  );
}
