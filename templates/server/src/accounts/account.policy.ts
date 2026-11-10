import { definePolicy, type PolicyDefinition } from '../policy/policy.registry';
import type { PolicyService } from '../policy/policy.service';

/** Effective values of the `account` policy (see `ACCOUNT_POLICY`). */
export interface AccountPolicyValues {
  [key: string]: boolean | number | string;
  registrationOpen: boolean;
  requireEmailVerification: boolean;
  /** Role id granted to every new account; '' means none. Checked against `roles` at sign-up, never `superadmin`. */
  initialRoleId: string;
  welcomeCreditsEnabled: boolean;
  welcomeCreditsAmount: number;
  /** 0 = welcome credits never expire. */
  welcomeCreditsValidDays: number;
}

/** Role ids are cuid/uuid-like; the policy store only checks shape, the sign-up path checks existence. */
const ROLE_ID = /^[A-Za-z0-9_-]{0,64}$/;
export const MAX_WELCOME_CREDITS = 1_000_000;

/**
 * Operator-controlled sign-up rules, hot-applied through the policy store. The defaults reproduce the
 * behaviour before this policy existed: open registration, mandatory e-mail verification, no initial
 * role, no welcome credits. `registrationOpen` and `requireEmailVerification` are public so the web
 * register page can hide the form or skip the "check your inbox" step; the rest stays private.
 * Pin any field with `POLICY_ACCOUNT_<FIELD>` (for example `POLICY_ACCOUNT_REQUIRE_EMAIL_VERIFICATION=false`).
 */
export const ACCOUNT_POLICY = definePolicy<AccountPolicyValues>({
  id: 'account',
  name: 'Accounts and sign-up',
  fields: [
    { key: 'registrationOpen', type: 'boolean', default: true, public: true, label: 'Allow new sign-ups',
      description: 'Off rejects both password registration and first-time OAuth sign-up. Existing accounts can still sign in.' },
    { key: 'requireEmailVerification', type: 'boolean', default: true, public: true, label: 'Require e-mail verification',
      description: 'Off lets password sign-up sign in immediately without account mail; unverified accounts keep working until this is turned back on.' },
    { key: 'initialRoleId', type: 'text', default: '', max: 64, label: 'Initial role id',
      description: 'Role id assigned to new accounts (empty for none). Unknown ids and the superadmin role are ignored at sign-up.' },
    { key: 'welcomeCreditsEnabled', type: 'boolean', default: false, label: 'Grant welcome credits' },
    { key: 'welcomeCreditsAmount', type: 'number', default: 0, min: 0, max: MAX_WELCOME_CREDITS, integer: true, label: 'Welcome credits' },
    { key: 'welcomeCreditsValidDays', type: 'number', default: 0, min: 0, max: 3650, integer: true, label: 'Welcome credit validity (days, 0 = never expire)' },
  ],
  validate(values) {
    if (!ROLE_ID.test(values.initialRoleId)) throw new Error('initialRoleId must be a role id');
    if (values.welcomeCreditsEnabled && values.welcomeCreditsAmount < 1) throw new Error('welcomeCreditsAmount must be positive when welcome credits are enabled');
  },
});

/** Policies contributed by the accounts feature, appended to `PolicyModule.forRoot({ policies })`. */
export const ACCOUNT_POLICIES: readonly PolicyDefinition[] = [ACCOUNT_POLICY];

const DEFAULTS: AccountPolicyValues = Object.freeze(Object.fromEntries(
  ACCOUNT_POLICY.fields.map(field => [field.key, field.default]),
)) as AccountPolicyValues;

/**
 * Effective account policy. Compositions without `PolicyModule`, or that have not registered
 * `ACCOUNT_POLICY` yet, get the declared defaults (today's behaviour); storage errors propagate.
 */
export async function readAccountPolicy(policies: PolicyService | undefined): Promise<AccountPolicyValues> {
  if (!policies || !policies.ids().includes(ACCOUNT_POLICY.id)) return DEFAULTS;
  return policies.get(ACCOUNT_POLICY);
}
