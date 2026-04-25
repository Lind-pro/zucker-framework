export type { MessageSource } from './message-source';
export {
  FileMessageSource,
  CompositeMessageSource,
} from './message-source';

export { LocaleContext, LocaleInterceptor } from './locale-context';

export { I18nException } from './i18n-exception';

export { I18nSpec } from './i18n-spec';

export {
  LocaleUtils,
  formatMessage,
  pluralize,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from './locale-utils';

export { I18n, getI18nCode, hasI18n } from './decorators';

export {
  ZuckerI18nModule,
  MESSAGE_SOURCE,
} from './i18n.module';
export type { I18nModuleOptions, I18nModuleAsyncOptions, I18nModuleOptionsFactory } from './i18n.module';
