import { settingsController } from '@zucker-framework/back-office/settings';
import { RUNTIME_SETTINGS_HOST } from './runtime-settings.module';

/** The generated `GET site/public/integrations` controller class. */
export const SiteIntegrationsController = settingsController(RUNTIME_SETTINGS_HOST, 'integrations')!;
