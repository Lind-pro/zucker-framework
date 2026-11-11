/**
 * Browser side of the account host's `login.identifier` option (`@zucker-framework/back-office/accounts`):
 * which body field `POST /authorize/login` expects and how a sign-in form should present the input.
 * Labels and wording stay with the application (its own i18n); this only fixes the wire and input contract.
 */
export type LoginIdentifier = 'username' | 'email' | 'username-or-email';

export interface LoginIdentifierInput {
  /** Request-body field of the identifier (`username`, `email` or `login`). */
  field: 'username' | 'email' | 'login';
  /** Input `type`: `email` only when an address is the sole accepted identifier. */
  type: 'text' | 'email';
  /** `autocomplete` token: `username` (also for addresses: it is the login-form identifier token password managers key on). */
  autoComplete: 'username';
  /** Virtual-keyboard hint. */
  inputMode: 'text' | 'email';
  /** Whether to trim surrounding whitespace before sending (always, like the server). */
  trim: true;
}

const INPUTS: Readonly<Record<LoginIdentifier, Readonly<LoginIdentifierInput>>> = Object.freeze({
  username: Object.freeze({ field: 'username', type: 'text', autoComplete: 'username', inputMode: 'text', trim: true }),
  email: Object.freeze({ field: 'email', type: 'email', autoComplete: 'username', inputMode: 'email', trim: true }),
  'username-or-email': Object.freeze({ field: 'login', type: 'text', autoComplete: 'username', inputMode: 'email', trim: true }),
});

/** Input presentation and body field of an identifier option (default `'username'`). Throws for an unknown option. */
export function loginIdentifierInput(identifier: LoginIdentifier = 'username'): Readonly<LoginIdentifierInput> {
  if (!Object.hasOwn(INPUTS, identifier)) throw new TypeError(`Unknown login identifier ${String(identifier)}`);
  return INPUTS[identifier];
}

/** `POST /authorize/login` body for the option: `{[field]: trimmed identifier, password}` (the password is sent as typed). */
export function loginRequestBody(identifier: LoginIdentifier | undefined, value: string, password: string): Record<string, string> {
  const { field } = loginIdentifierInput(identifier);
  return { [field]: value.trim(), password };
}
