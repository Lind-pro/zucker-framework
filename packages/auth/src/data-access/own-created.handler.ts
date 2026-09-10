import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { DataAccessHandler, AuthorizingContext } from './data-access-handler';
import type { DataAccessConfig, OwnCreatedDataAccessConfig } from './data-access-config';
import { DefaultDataAccessType } from './data-access-config';
import type { DataAccessResult } from './data-access-result';
import { allowResult, denyResult, filterResult } from './data-access-result';
import { DATABASE_ADAPTER } from '../guards/data-permission.guard';

export const OWN_CREATED_OPTIONS = Symbol('OWN_CREATED_OPTIONS');
export interface OwnCreatedHandlerOptions {
  /** An explicit resource grant may authorize a non-owner; the consumer maps its grant store. */
  hasExplicitGrant?: (context: AuthorizingContext, resourceId: string) => Promise<boolean>;
}

/**
 * Handles OwnCreated data access control.
 * Restricts access to records created by the current user.
 * The creator field name is configurable (defaults to 'creatorId').
 */
@Injectable()
export class OwnCreatedDataAccessHandler implements DataAccessHandler {
  private readonly logger = new Logger(OwnCreatedDataAccessHandler.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(OWN_CREATED_OPTIONS) private readonly options?: OwnCreatedHandlerOptions,
  ) {}

  isSupport(config: DataAccessConfig): boolean {
    return config.type.id === DefaultDataAccessType.OWN_CREATED.id;
  }

  async handle(config: DataAccessConfig, context: AuthorizingContext): Promise<DataAccessResult> {
    const ownConfig = config as OwnCreatedDataAccessConfig;
    const creatorField = ownConfig.creatorField || 'creatorId';
    const userId = context.authentication.getUser().id;

    const resourceId = context.request.params.id;
    // A detail read must verify the actual owner; filters only constrain collection queries.
    if (!resourceId && ['query', 'get', 'read'].includes(context.action)) {
      return filterResult([{ column: creatorField, termType: 'eq', value: userId }]);
    }

    // For mutation actions, check the specific resource if an ID is present
    if (!resourceId) {
      // No specific resource targeted (e.g. batch create) — allow
      return allowResult();
    }

    try {
      const model = this.db.model(context.dataType);
      const resource = await model.findUnique({
        where: { id: resourceId },
        select: { [creatorField]: true },
      });

      if (!resource) {
        return denyResult();
      }

      const isOwner = (resource as Record<string, unknown>)[creatorField] === userId;
      return isOwner || (await this.options?.hasExplicitGrant?.(context, resourceId))
        ? allowResult()
        : denyResult();
    } catch {
      this.logger.warn(`OwnCreated check failed for ${context.dataType}:${resourceId}`);
      return denyResult();
    }
  }
}
