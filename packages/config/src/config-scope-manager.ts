import { Injectable, Logger } from '@nestjs/common';
import type { ConfigScope, ConfigPropertyDef } from './index';

/**
 * ConfigScopeCustomizer — implement to register custom config scopes.
 *
 * Reference: jetlinks ConfigScopeCustomizer
 */
export interface ConfigScopeCustomizer {
  custom(manager: ConfigScopeManager): void;
}

/**
 * ConfigScopeManager — register and retrieve config scopes.
 *
 * Reference: jetlinks ConfigScopeManager + SimpleConfigManager
 */
@Injectable()
export class ConfigScopeManager {
  private readonly logger = new Logger(ConfigScopeManager.name);
  private readonly scopes = new Map<string, ConfigScope>();

  /**
   * Register a fully defined scope.
   */
  register(scope: ConfigScope): void {
    this.scopes.set(scope.id, scope);
    this.logger.debug(`Config scope registered: ${scope.id} (${scope.name})`);
  }

  /**
   * Add a scope with separate property definitions — mirrors jetlinks ConfigScopeManager.addScope().
   *
   * Reference: jetlinks ConfigScopeManager.addScope(ConfigScope, List<ConfigPropertyDef>)
   */
  addScope(
    scopePartial: { id: string; name: string; publicAccess?: boolean },
    properties: ConfigPropertyDef[],
  ): void {
    const existing = this.scopes.get(scopePartial.id);
    if (existing) {
      // Merge properties into existing scope (like jetlinks computeIfAbsent + addAll)
      const existingKeys = new Set(existing.properties.map((p) => p.key));
      for (const prop of properties) {
        if (!existingKeys.has(prop.key)) {
          existing.properties.push(prop);
          existingKeys.add(prop.key);
        }
      }
      return;
    }

    const scope: ConfigScope = {
      id: scopePartial.id,
      name: scopePartial.name,
      isPublic: scopePartial.publicAccess ?? false,
      publicAccess: scopePartial.publicAccess ?? false,
      properties,
    };
    this.scopes.set(scope.id, scope);
    this.logger.debug(`Config scope added: ${scope.id} (${scope.name})`);
  }

  /**
   * Apply customizers — call during module initialization.
   *
   * Reference: jetlinks ConfigScopeProperties.custom()
   */
  applyCustomizers(customizers: ConfigScopeCustomizer[]): void {
    for (const customizer of customizers) {
      customizer.custom(this);
    }
  }

  get(scopeId: string): ConfigScope | undefined {
    return this.scopes.get(scopeId);
  }

  getAll(): ConfigScope[] {
    return Array.from(this.scopes.values());
  }

  has(scopeId: string): boolean {
    return this.scopes.has(scopeId);
  }

  unregister(scopeId: string): boolean {
    return this.scopes.delete(scopeId);
  }

  /**
   * Get all scopes marked as public access.
   *
   * Reference: jetlinks SystemConfigManagerController checks isPublicAccess()
   * for unauthenticated access.
   */
  getPublicScopes(): ConfigScope[] {
    return Array.from(this.scopes.values()).filter((s) => s.publicAccess);
  }

  getProperties(scopeId: string): ConfigPropertyDef[] {
    return this.scopes.get(scopeId)?.properties ?? [];
  }

  /**
   * Validate a config value against its scope property definition.
   * Returns error messages if invalid.
   */
  validate(
    scopeId: string,
    key: string,
    value: unknown,
  ): string[] {
    const scope = this.scopes.get(scopeId);
    if (!scope) return [`Unknown scope: ${scopeId}`];

    const prop = scope.properties.find((p) => p.key === key);
    if (!prop) return [`Unknown property: ${key} in scope ${scopeId}`];

    const errors: string[] = [];

    if (prop.readonly) {
      errors.push(`Property ${key} is read-only`);
    }

    if (value === null || value === undefined) {
      return errors;
    }

    // Type checking
    const actualType = typeof value;
    switch (prop.type) {
      case 'string':
        if (actualType !== 'string') errors.push(`Expected string for ${key}, got ${actualType}`);
        break;
      case 'number':
        if (actualType !== 'number') errors.push(`Expected number for ${key}, got ${actualType}`);
        break;
      case 'boolean':
        if (actualType !== 'boolean') errors.push(`Expected boolean for ${key}, got ${actualType}`);
        break;
      case 'json':
      case 'object':
        if (actualType !== 'object') errors.push(`Expected object for ${key}, got ${actualType}`);
        break;
      case 'password':
      case 'encrypted':
        // Encrypted fields accept strings
        if (actualType !== 'string') errors.push(`Expected string for encrypted ${key}, got ${actualType}`);
        break;
    }

    return errors;
  }
}
