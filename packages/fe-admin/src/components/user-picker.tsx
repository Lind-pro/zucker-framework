import { useEffect, useId, useState } from 'react';
import { useAdmin, useAdminApi } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { assertPage } from './data-table';
import { Field, Input } from './inputs';

export interface PickedUser {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
}

const SEARCH_DELAY_MS = 250;
const RESULT_LIMIT = 8;

/**
 * Searchable account picker over `POST {endpoints.users}/_query` (`username$like`, or `email$like`
 * when the term contains `@`; USER_FILTER of `@zucker-framework/admin`). Reusable wherever a form
 * needs an account id; it only reports the choice, the form keeps the id field.
 */
export function UserPicker({ onSelect, disabled, label }: { onSelect: (user: PickedUser) => void; disabled?: boolean; label?: string }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PickedUser[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const query = term.trim();

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState('loading');
      const filter = query.includes('@') ? { email$like: query } : { username$like: query };
      api
        .post(`${config.endpoints.users}/_query`, { pageIndex: 0, pageSize: RESULT_LIMIT, filter }, { signal: controller.signal })
        .then((value) => {
          setResults(assertPage<PickedUser>(value).data);
          setState('idle');
        })
        .catch(() => {
          if (!controller.signal.aborted) setState('error');
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, config.endpoints.users, query]);

  return (
    <Field label={label ?? t('userPicker.label')} description={state === 'error' ? t('userPicker.failed') : t('userPicker.hint')}>
      {({ id, describedBy }) => (
        <div className="space-y-1">
          <Input
            id={id}
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-describedby={describedBy}
            autoComplete="off"
            maxLength={254}
            disabled={disabled}
            value={term}
            placeholder={t('userPicker.placeholder')}
            onChange={(event) => setTerm(event.target.value)}
            // Enter searches; it must not submit the surrounding form.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          {query.length >= 2 && state === 'idle' && results.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('userPicker.empty')}</p>
          )}
          {results.length > 0 && (
            <ul id={listId} role="listbox" aria-label={label ?? t('userPicker.label')} className="max-h-48 overflow-auto rounded-md border">
              {results.map((user) => (
                <li key={user.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    disabled={disabled}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => {
                      onSelect(user);
                      setTerm(user.username);
                      setResults([]);
                    }}
                  >
                    <span className="font-medium">{user.username}</span>
                    {user.email && <span className="ml-2 text-muted-foreground break-all">{user.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}
