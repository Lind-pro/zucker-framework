import { SetMetadata } from '@nestjs/common';

/** Only explicitly annotated API endpoints can choose key authentication instead of a JWT session. */
export const ACCOUNT_API_KEY_SCOPES = Symbol('ACCOUNT_API_KEY_SCOPES');
export const ACCOUNT_API_KEY_AUTHENTICATOR = Symbol('ACCOUNT_API_KEY_AUTHENTICATOR');
export const AccountApiKeyScopes = (...scopes: string[]) => SetMetadata(ACCOUNT_API_KEY_SCOPES, scopes);
