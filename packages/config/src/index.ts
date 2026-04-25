export interface ConfigPropertyDef {
  key: string;
  name: string;
  type: string;
  defaultValue: unknown;
  description: string;
  readonly: boolean;
  /** Whether this property value should be encrypted at rest */
  encrypted?: boolean;
  /** Sort order for display */
  sortOrder?: number;
}

export interface ConfigScope {
  id: string;
  name: string;
  isPublic: boolean;
  /** Whether public access is allowed (no auth required) */
  publicAccess: boolean;
  properties: ConfigPropertyDef[];
}

export {
  ConfigService,
  DATABASE_ADAPTER,
  CONFIG_CHANGED_EVENT,
  CONFIG_CHANGED_TOPIC,
  CONFIG_ENCRYPTOR,
} from './config.service';
export type { ConfigChangePayload, ConfigEncryptor } from './config.service';
export { ZuckerConfigModule } from './config.module';
export { CONFIG_MODULE_OPTIONS } from './config.module';
export type { ZuckerConfigModuleOptions, ZuckerConfigModuleAsyncOptions, ZuckerConfigModuleOptionsFactory } from './config.module';
export { ConfigGuard, CONFIG_SCOPE_REGISTRY } from './config.guard';
export type { ConfigScopeEntry } from './config.guard';
export { ConfigScopeManager } from './config-scope-manager';
export type { ConfigScopeCustomizer } from './config-scope-manager';
export {
  LayeredConfigService,
  LAYERED_CONFIG_CHANGED_EVENT,
  LAYERED_CONFIG_CHANGED_TOPIC,
  CONFIG_LAYER_PRIORITY,
} from './layered-config.service';
export type {
  ConfigLayer,
  LayeredConfigChangePayload,
  LayeredConfigContext,
} from './layered-config.service';

export { FeatureFlagService } from './feature-flags';
export type { FlagDefinition, FlagRule, FlagRuleType, FlagContext } from './feature-flags';

export { ConfigFileWatcher } from './config-watcher';
export type { ConfigWatcherOptions } from './config-watcher';
