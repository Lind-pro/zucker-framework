import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { DataAccessHandler, AuthorizingContext } from './data-access-handler';
import type { DataAccessConfig, DimensionDataAccessConfig } from './data-access-config';
import { DefaultDataAccessType } from './data-access-config';
import type { DataAccessResult } from './data-access-result';
import { filterResult, allowResult, denyResult } from './data-access-result';
import { DATABASE_ADAPTER } from '../guards/data-permission.guard';
import type { DimensionService } from '../services/dimension.service';

/**
 * Handles dimension-based row-level access control.
 * Uses DimensionService to resolve user dimensions and inject
 * WHERE conditions or check resource membership.
 *
 * Refactored from the original hard-coded logic in DataPermissionGuard.
 */
@Injectable()
export class DimensionDataAccessHandler implements DataAccessHandler {
  private readonly logger = new Logger(DimensionDataAccessHandler.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() private readonly dimensionService?: DimensionService,
  ) {}

  isSupport(config: DataAccessConfig): boolean {
    return config.type.id === DefaultDataAccessType.DIMENSION_SCOPE.id;
  }

  async handle(config: DataAccessConfig, context: AuthorizingContext): Promise<DataAccessResult> {
    if (!this.dimensionService) {
      // No dimension service available, skip this handler
      return allowResult();
    }

    const dimConfig = config as DimensionDataAccessConfig;
    const userId = context.authentication.getUser().id;
    const dimensionField = dimConfig.dimensionField || 'dimensionId';

    // For query actions, inject a filter condition
    if (config.action === 'query' || config.action === 'get') {
      // When children=true (default), expand dimension tree; otherwise use direct values only
      // Include child dimensions when configured
      const useChildren = dimConfig.children !== false;

      let dimensionValues: string[];
      if (useChildren) {
        const expandedDimensions =
          await this.dimensionService.getExpandedUserDimensions(userId);
        dimensionValues = dimConfig.dimensionType
          ? expandedDimensions.get(dimConfig.dimensionType) || []
          : Array.from(expandedDimensions.values()).flat();
      } else {
        dimensionValues = dimConfig.dimensionType
          ? await this.dimensionService.getUserDimensionValues(userId, dimConfig.dimensionType)
          : (await this.dimensionService.getUserDimensions(userId)).map((d) => d.id);
      }

      if (dimensionValues.length === 0) {
        // 维度处理器的适用条件：
        // 当用户没有任何匹配维度时，应拒绝访问而非放行全部数据
        this.logger.warn(
          `用户 ${userId} 没有任何 ${dimConfig.dimensionType || '所有'} 类型的维度，拒绝访问`,
        );
        return denyResult();
      }

      return filterResult([
        { column: dimensionField, termType: 'in', value: dimensionValues },
      ]);
    }

    // For mutation actions, check if the resource belongs to user's dimensions
    const resourceId = context.request.params.id;
    if (!resourceId) {
      return allowResult();
    }

    try {
      const resource = await this.db.model(context.dataType).findUnique({
        where: { id: resourceId },
      });

      if (!resource) return denyResult();

      const dimensionId = (resource as Record<string, unknown>)[dimensionField];
      if (!dimensionId) return allowResult();

      const expandedDimensions =
        await this.dimensionService.getExpandedUserDimensions(userId);

      for (const [type, values] of expandedDimensions) {
        if (dimConfig.dimensionType && type !== dimConfig.dimensionType) continue;
        if (values.includes(String(dimensionId))) {
          return allowResult();
        }
      }

      return denyResult();
    } catch (error) {
      this.logger.warn(
        `Dimension check failed for ${context.dataType}:${resourceId}: ${error}`,
      );
      return denyResult();
    }
  }
}
