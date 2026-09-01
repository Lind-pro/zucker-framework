import { Injectable } from '@nestjs/common';
import type { DataAccessHandler, AuthorizingContext } from './data-access-handler';
import type { DataAccessConfig, ScopeDataAccessConfig } from './data-access-config';
import { DefaultDataAccessType } from './data-access-config';
import type { DataAccessResult } from './data-access-result';
import { filterResult, allowResult } from './data-access-result';

/**
 * Handles scope-based row-level access control.
 * Injects WHERE conditions based on scope type and values.
 * E.g., only allow access to records within certain organizations.
 */
@Injectable()
export class ScopeDataAccessHandler implements DataAccessHandler {
  isSupport(config: DataAccessConfig): boolean {
    return config.type.id === DefaultDataAccessType.SCOPE.id;
  }

  async handle(config: DataAccessConfig, _context: AuthorizingContext): Promise<DataAccessResult> {
    const scopeConfig = config as ScopeDataAccessConfig;

    if (!scopeConfig.scope || scopeConfig.scope.length === 0) {
      return allowResult();
    }

    // Inject a filter condition: scopeType column IN scope values
    return filterResult([
      {
        column: scopeConfig.scopeType,
        termType: 'in',
        value: scopeConfig.scope,
      },
    ]);
  }
}
