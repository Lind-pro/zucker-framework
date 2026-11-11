import { backOfficeToken } from '../shared/tokens';

/** Resolved `BackOfficeMailOptions`. */
export const MAIL_OPTIONS = backOfficeToken('mail', 'options');
/** The consumer's `MailSettingsSource` (transport settings). */
export const MAIL_SETTINGS_SOURCE = backOfficeToken('mail', 'settingsSource');
/** The consumer's `MailSitePort` (`webUrl`, `siteName`). */
export const MAIL_SITE = backOfficeToken('mail', 'site');
/** `AccountMailer` implementation for the accounts host (`useExisting: BackOfficeAccountMailer`). */
export const MAIL_ACCOUNT_MAILER = backOfficeToken('mail', 'accountMailer');
