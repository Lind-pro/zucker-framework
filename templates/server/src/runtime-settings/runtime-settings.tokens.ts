/** Internal server environment snapshot. Never return this token through an HTTP response. */
export const RUNTIME_ENVIRONMENT = Symbol('RUNTIME_ENVIRONMENT');
/** Bootstrap inputs, copied once; tests may override with synthetic configuration. */
export const RUNTIME_SETTINGS_BASE_ENV = Symbol('RUNTIME_SETTINGS_BASE_ENV');
