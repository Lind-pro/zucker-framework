import { createAccountController } from '@zucker-framework/back-office/accounts';
import { templateAccountOptions } from './account.config';

/** All `/authorize/*` core routes; narrow compositions without `AccountModule` get the template options. */
export const AccountController = createAccountController({ fallback: templateAccountOptions });
