// The account host lives in @zucker-framework/back-office/accounts; these names keep the template's import paths.
export {
  AccountService, ACCOUNTS_MAILER as ACCOUNT_MAILER, DELETED_USERNAME_PREFIX,
  type AccountMailer, type AccountMailPurpose, type RegisterResult, type RegisterRequestContext, type TwoFactorChallengePurpose,
  type AccountTicketPurpose, type AccountTicket, type AccountSession, type SignInMethod, type SessionPair, type SignInResult,
} from '@zucker-framework/back-office/accounts';
export const ACCESS_TTL_SECONDS = 900;
export const SESSION_TTL_SECONDS = 30 * 86400;
