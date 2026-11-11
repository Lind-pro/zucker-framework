import { settingsController } from '@zucker-framework/back-office/settings';
import { RUNTIME_SETTINGS_HOST } from './runtime-settings.module';

/** The generated `management/connection-settings` controller class (interceptors match on it, e.g. the D14 storage guard). */
export const ConnectionSettingsController = settingsController(RUNTIME_SETTINGS_HOST, 'connections')!;
