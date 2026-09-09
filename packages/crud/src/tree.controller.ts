import {
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  Type,
} from '@nestjs/common';
import { ApiResponse, ApiOperation } from '@nestjs/swagger';
import { type TreeSortSupportEntity } from '@zucker-framework/core';
import { TreeService } from './tree.service';
import { type DynamicQueryParam } from './dynamic-query.service';

export class TreeControllerHost<T extends TreeSortSupportEntity> {
  protected declare readonly service: TreeService<T>;

  findAllTree(..._args: unknown[]): Promise<T[]> { throw new Error('Not implemented'); }
  findAllChildren(..._args: unknown[]): Promise<T[]> { throw new Error('Not implemented'); }
  findAllChildrenTree(..._args: unknown[]): Promise<T[]> { throw new Error('Not implemented'); }
}

/**
 * 树形结构控制器工厂
 * 提供树形查询和树节点 CRUD 路由
 *
 * 路由:
 * - GET  /_query/tree          动态查询并返回树形结构
 * - POST /_query/tree          POST方式动态查询并返回树形结构
 * - GET  /_query/_children     动态查询并返回子节点数据(扁平)
 * - POST /_query/_children     POST方式动态查询并返回子节点数据(扁平)
 * - GET  /_query/_children/tree  动态查询并返回子节点树形结构
 * - POST /_query/_children/tree  POST方式动态查询并返回子节点树形结构
 * - DELETE /{id}               删除节点及其所有子节点
 */
export function TreeController<T extends TreeSortSupportEntity>(
  EntityClass: Type<T>,
): Type<TreeControllerHost<T>> {
  class TreeControllerHostImpl {
    constructor(protected readonly service: TreeService<T>) {}

    /**
     * GET 方式动态查询并返回树形结构
     */
    @Get('_query/tree')
    @ApiOperation({ summary: '使用GET动态查询并返回树形结构' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllTree(@Query() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryResultToTree(query);
    }

    /**
     * POST 方式动态查询并返回树形结构
     */
    @Post('_query/tree')
    @ApiOperation({ summary: '使用POST动态查询并返回树形结构' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllTreePost(@Body() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryResultToTree(query);
    }

    /**
     * GET 方式动态查询并返回子节点数据（扁平列表）
     */
    @Get('_query/_children')
    @ApiOperation({ summary: '使用GET动态查询并返回子节点数据' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllChildren(@Query() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryIncludeChildrenByQuery(query);
    }

    /**
     * POST 方式动态查询并返回子节点数据（扁平列表）
     */
    @Post('_query/_children')
    @ApiOperation({ summary: '使用POST动态查询并返回子节点数据' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllChildrenPost(@Body() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryIncludeChildrenByQuery(query);
    }

    /**
     * GET 方式动态查询并返回子节点树形结构
     */
    @Get('_query/_children/tree')
    @ApiOperation({ summary: '使用GET动态查询并返回子节点树形结构数据' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllChildrenTree(@Query() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryIncludeChildrenTree(query);
    }

    /**
     * POST 方式动态查询并返回子节点树形结构
     */
    @Post('_query/_children/tree')
    @ApiOperation({ summary: '使用POST动态查询并返回子节点树形结构数据' })
    @ApiResponse({ status: HttpStatus.OK })
    async findAllChildrenTreePost(@Body() query: DynamicQueryParam): Promise<T[]> {
      return this.service.queryIncludeChildrenTree(query);
    }

    /**
     * 删除节点及其所有子节点
     * 级联删除子节点
     */
    @Delete(':id')
    @ApiOperation({ summary: '删除节点及其所有子节点' })
    @ApiResponse({ status: HttpStatus.OK })
    async deleteWithChildren(@Param('id') id: string): Promise<{ count: number }> {
      const descendants = await this.service.findWithChildren(id);
      const ids = descendants.map((d) => d.id);
      const count = await this.service.deleteBatch(ids);
      return { count };
    }
  }

  return TreeControllerHostImpl as unknown as Type<TreeControllerHost<T>>;
}
