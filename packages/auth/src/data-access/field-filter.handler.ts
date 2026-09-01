import { Injectable } from '@nestjs/common';
import type { DataAccessHandler, AuthorizingContext } from './data-access-handler';
import type { DataAccessConfig, FieldFilterDataAccessConfig } from './data-access-config';
import { DefaultDataAccessType } from './data-access-config';
import type { DataAccessResult } from './data-access-result';

/**
 * Handles field-level access control.
 * Returns denyFields list so that the guard or downstream service
 * can strip these fields from query results or reject mutations on them.
 */
@Injectable()
export class FieldFilterDataAccessHandler implements DataAccessHandler {
  isSupport(config: DataAccessConfig): boolean {
    return config.type.id === DefaultDataAccessType.DENY_FIELDS.id;
  }

  async handle(config: DataAccessConfig, _context: AuthorizingContext): Promise<DataAccessResult> {
    const fieldConfig = config as FieldFilterDataAccessConfig;
    return {
      allowed: true,
      denyFields: fieldConfig.fields,
    };
  }
}
