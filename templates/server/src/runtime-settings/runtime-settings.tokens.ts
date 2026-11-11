/**
 * Template names of the settings host tokens (`@zucker-framework/back-office/settings`).
 * `RUNTIME_ENVIRONMENT`: internal server environment snapshot; never return it through an HTTP response.
 * `RUNTIME_SETTINGS_BASE_ENV`: bootstrap inputs, copied once; tests may override with synthetic configuration.
 */
export { SETTINGS_RUNTIME_ENVIRONMENT as RUNTIME_ENVIRONMENT, SETTINGS_BASE_ENVIRONMENT as RUNTIME_SETTINGS_BASE_ENV } from '@zucker-framework/back-office/settings';
