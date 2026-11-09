import { UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/button';
import { ConfirmButton } from '../components/dialog';
import { ErrorState, LoadingState, StatusBadge, toast } from '../components/feedback';
import { Field, Input } from '../components/inputs';
import { KeyValueList, PageContainer, Panel } from '../components/layout';
import { DataTable } from '../components/data-table';
import { Tabs } from '../components/tabs';
import { useAdmin, useAdminApi, useResource } from '../app/context';
import type { AdminUser } from '../app/session';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { enc } from './shared';

interface SessionRow {
  id: string;
  current: boolean;
  expiresAt?: string;
  lastActiveAt?: string;
}

function ProfileForm({ profile, onSaved }: { profile: AdminUser; onSaved: (name: string) => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const [name, setName] = useState(profile.name ?? '');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('common.required', { label: t('profile.name') }));
      return;
    }
    setSaving(true);
    try {
      const result = await api.post<{ success?: boolean }>(config.endpoints.profile, { name: trimmed });
      if (result?.success !== true) throw new Error('Unexpected profile response');
      onSaved(trimmed);
      toast.success(t('profile.updated'));
    } catch {
      toast.error(t('profile.updateFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
      <Field label={t('profile.name')} required error={error}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            name="name"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
          />
        )}
      </Field>
      <Field label={t('profile.email')} description={profile.email ? undefined : t('profile.noEmail')}>
        {({ id }) => <Input id={id} name="email" disabled value={profile.email ?? ''} />}
      </Field>
      <Button type="submit" variant="primary" loading={saving}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function PasswordForm() {
  const { config, session } = useAdmin();
  const { t } = useAdminI18n();
  const navigate = useNavigate();
  const [values, setValues] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<'current' | 'next' | 'confirm', string>>>({});
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    if (!values.current) next.current = t('common.required', { label: t('profile.currentPassword') });
    if (values.next.length < 8) next.next = t('profile.passwordTooShort');
    if (values.next !== values.confirm) next.confirm = t('profile.passwordMismatch');
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      // Confirm the session first so an expired token is refreshed before the credential change.
      await session.api.get(config.endpoints.me);
      const token = session.store.getState().token ?? '';
      const result = await session.publicApi.post<{ success?: boolean }>(
        config.endpoints.password,
        { currentPassword: values.current, password: values.next },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (result?.success !== true) throw new Error('Unexpected password response');
      session.store.getState().logout();
      toast.success(t('profile.passwordChanged'));
      navigate('/login', { replace: true });
    } catch {
      toast.error(t('profile.passwordFailed'));
    } finally {
      setSaving(false);
    }
  }
  const input = (key: 'current' | 'next' | 'confirm', label: string, autoComplete: string, description?: string) => (
    <Field label={label} required error={errors[key]} description={description}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          name={key}
          type="password"
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={values[key]}
          onChange={(event) => {
            setValues((previous) => ({ ...previous, [key]: event.target.value }));
            setErrors((previous) => ({ ...previous, [key]: undefined }));
          }}
        />
      )}
    </Field>
  );
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
      {input('current', t('profile.currentPassword'), 'current-password')}
      {input('next', t('profile.newPassword'), 'new-password', t('profile.newPasswordHint'))}
      {input('confirm', t('profile.confirmPassword'), 'new-password')}
      <Button type="submit" variant="primary" loading={saving}>
        {t('profile.password')}
      </Button>
    </form>
  );
}

function Sessions() {
  const { config, session } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const navigate = useNavigate();
  const sessions = useResource(async (signal) => {
    const rows = await api.get<unknown>(config.endpoints.sessions, undefined, { signal });
    if (!Array.isArray(rows)) throw new Error('Unexpected sessions response');
    return rows as SessionRow[];
  }, []);
  return (
    <DataTable<SessionRow>
      label={t('profile.sessions')}
      rows={sessions.data ?? []}
      rowKey={(row) => row.id}
      loading={sessions.loading}
      error={sessions.error ? t('profile.sessionsFailed') : false}
      onRetry={sessions.reload}
      columns={[
        {
          key: 'id',
          title: t('common.id'),
          render: (row) => (
            <span className="flex flex-wrap items-center gap-1">
              <code className="text-xs">{row.id}</code>
              {row.current && <StatusBadge tone="info">{t('profile.sessionCurrent')}</StatusBadge>}
            </span>
          ),
        },
        { key: 'lastActiveAt', title: t('profile.sessionLastActive'), render: (row) => formatDateTime(row.lastActiveAt, locale) },
        { key: 'expiresAt', title: t('profile.sessionExpires'), render: (row) => formatDateTime(row.expiresAt, locale) },
      ]}
      actions={(row) => (
        <ConfirmButton
          size="sm"
          variant="ghost"
          destructive
          title={t('profile.sessionRevoke')}
          description={row.id}
          onConfirm={async () => {
            try {
              await api.delete(`${config.endpoints.sessions}/${enc(row.id)}`);
              toast.success(t('profile.sessionRevoked'));
              if (row.current) {
                session.store.getState().logout();
                navigate('/login', { replace: true });
              } else sessions.reload();
            } catch (error) {
              toast.error(t('profile.sessionRevokeFailed'));
              throw error;
            }
          }}
        >
          {t('profile.sessionRevoke')}
        </ConfirmButton>
      )}
    />
  );
}

/** Account profile over `/authorize/me|profile|password|sessions`. */
export function ProfilePage() {
  const { config, session } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const profile = useResource(async (signal) => {
    const me = await api.get<AdminUser>(config.endpoints.me, undefined, { signal });
    if (!me || typeof me.id !== 'string' || typeof me.username !== 'string') throw new Error('Invalid profile response');
    return me;
  }, []);
  if (profile.loading && !profile.data) return <LoadingState />;
  if (profile.error || !profile.data)
    return (
      <PageContainer title={t('page.profile')}>
        <ErrorState message={`${t('profile.loadFailed')} — ${t('profile.loadFailedDescription')}`} onRetry={profile.reload} />
      </PageContainer>
    );
  const me = profile.data;
  return (
    <PageContainer title={t('page.profile')}>
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
            <UserRound className="size-7" />
          </span>
          <div className="min-w-0">
            <p className="text-lg font-semibold break-all">{me.name || me.username}</p>
            <p className="text-sm text-muted-foreground break-all">
              {me.email || t('profile.noEmail')}{' '}
              {me.email && (
                <StatusBadge tone={me.emailVerified ? 'success' : 'warning'}>
                  {me.emailVerified ? t('profile.emailVerified') : t('profile.emailUnverified')}
                </StatusBadge>
              )}
            </p>
          </div>
        </div>
      </Panel>
      <Panel>
        <Tabs
          label={t('page.profile')}
          items={[
            {
              value: 'info',
              label: t('profile.info'),
              content: (
                <div className="space-y-5">
                  <KeyValueList items={[{ label: t('shell.username'), value: me.username }]} />
                  <ProfileForm
                    profile={me}
                    onSaved={(name) => {
                      profile.setData({ ...me, name });
                      const user = session.store.getState().user;
                      if (user) session.store.getState().updateUser({ ...user, name });
                    }}
                  />
                </div>
              ),
            },
            { value: 'password', label: t('profile.password'), content: <PasswordForm /> },
            { value: 'sessions', label: t('profile.sessions'), content: <Sessions /> },
          ]}
        />
      </Panel>
    </PageContainer>
  );
}
