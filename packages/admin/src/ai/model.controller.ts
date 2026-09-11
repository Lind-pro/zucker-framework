import {
  Controller,
  Inject,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { AIModelCatalogService, type AIModelWrite, type AIModelQuery } from '@zucker-framework/ai';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';

export interface AIModelAdminOptions {
  path: string;
  permissions: { read: string; readSecret: string; create: string; update: string; delete: string };
  guards?: import('@nestjs/common').Type<import('@nestjs/common').CanActivate>[];
}
export function createAIModelAdminController(
  options: AIModelAdminOptions,
): Type<
  Pick<
    AIModelCatalogService,
    | 'getAllModels'
    | 'getModelById'
    | 'getDefaultModel'
    | 'createModel'
    | 'updateModel'
    | 'deleteModel'
    | 'setDefaultModel'
    | 'testModelConnection'
  > & { getModelByIdFull(id: string): ReturnType<AIModelCatalogService['getModelById']> }
> {
  @Controller(options.path)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class AIModelAdminController {
    constructor(
      @Inject(AIModelCatalogService) private readonly aiModelService: AIModelCatalogService,
    ) {}

    /**
     * 获取所有 AI 模型配置
     */
    @Get()
    @Permissions(options.permissions.read)
    async getAllModels(@Query() query: AIModelQuery) {
      return this.aiModelService.getAllModels(query);
    }

    /**
     * 获取默认模型
     */
    @Get('default/current')
    @Permissions(options.permissions.read)
    async getDefaultModel() {
      const model = await this.aiModelService.getDefaultModel();
      return {
        ...model,
        apiKey: '****', // 不返回完整的 API Key
      };
    }

    /**
     * 获取单个 AI 模型配置
     */
    @Get(':id')
    @Permissions(options.permissions.read)
    async getModelById(@Param('id') id: string) {
      return this.aiModelService.getModelById(id, false);
    }

    /** Secret disclosure has a separate permission from ordinary model reads. */
    @Get(':id/full')
    @Permissions(options.permissions.readSecret)
    async getModelByIdFull(@Param('id') id: string) {
      return this.aiModelService.getModelById(id, true);
    }

    /**
     * 创建 AI 模型配置
     */
    @Post()
    @Permissions(options.permissions.create)
    @AccessLogger({
      describe: '创建AI模型配置',
      module: 'ai-model',
      action: 'create',
      targetType: 'AIModel',
      logParameters: true, // 自动脱敏敏感字段（apiKey等）
    })
    async createModel(
      @Body()
      data: AIModelWrite,
    ) {
      return this.aiModelService.createModel(data);
    }

    /**
     * 更新 AI 模型配置
     */
    @Put(':id')
    @Permissions(options.permissions.update)
    @AccessLogger({
      describe: '更新AI模型配置',
      module: 'ai-model',
      action: 'update',
      targetType: 'AIModel',
      logParameters: true, // 自动脱敏敏感字段（apiKey等）
    })
    async updateModel(
      @Param('id') id: string,
      @Body()
      data: AIModelWrite,
    ) {
      return this.aiModelService.updateModel(id, data);
    }

    /**
     * 删除 AI 模型配置
     */
    @Delete(':id')
    @Permissions(options.permissions.delete)
    @AccessLogger({
      describe: '删除AI模型配置',
      module: 'ai-model',
      action: 'delete',
      targetType: 'AIModel',
    })
    async deleteModel(@Param('id') id: string) {
      return this.aiModelService.deleteModel(id);
    }

    /**
     * 设置默认模型
     */
    @Post(':id/set-default')
    @Permissions(options.permissions.update)
    @AccessLogger({
      describe: '设置默认AI模型',
      module: 'ai-model',
      action: 'setDefault',
      targetType: 'AIModel',
    })
    async setDefaultModel(@Param('id') id: string) {
      return this.aiModelService.setDefaultModel(id);
    }

    /**
     * 测试模型连接
     */
    @Post(':id/test')
    @Permissions(options.permissions.read)
    async testModelConnection(@Param('id') id: string) {
      return this.aiModelService.testModelConnection(id);
    }
  }

  return AIModelAdminController;
}
