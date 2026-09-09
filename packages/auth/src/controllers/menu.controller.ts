/**
 * MenuController — 菜单管理接口
 *
 * - GET  /api/menu/tree       — 获取当前用户可见菜单树
 * - GET  /api/menu/all        — 获取全部菜单（管理用）
 * - GET  /api/menu/:id        — 查询单个菜单
 * - POST /api/menu            — 创建菜单
 * - PUT  /api/menu/:id        — 更新菜单
 * - DELETE /api/menu/:id      — 删除菜单
 * - PUT  /api/menu/:id/sort   — 排序菜单
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  Inject,
} from '@nestjs/common';
import { MenuService } from '../services/menu.service';
import { PermissionService } from '../services/permission.service';
import { Permissions } from '../decorators';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { DATABASE_ADAPTER } from '../guards/data-permission.guard';

@Controller('menu')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly permissionService: PermissionService,
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
  ) {}

  /** GET /api/menu/tree — 获取当前用户可见的菜单树 */
  @Get('tree')
  @Permissions()
  async getMenuTree(@Req() req: { user: { id: string } }) {
    const userId = req.user.id;
    const userPermissions =
      await this.permissionService.findUserPermissions(userId);
    return this.menuService.getMenuTreeByUserId(userId, userPermissions);
  }

  /** GET /api/menu/all — 获取全部菜单列表（管理端用） */
  @Get('all')
  @Permissions()
  async getAllMenus() {
    return this.db.model('menus').findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** GET /api/menu/:id — 查询单个菜单 */
  @Get(':id')
  @Permissions()
  async findOne(@Param('id') id: string) {
    return this.db.model('menus').findUnique({ where: { id } });
  }

  /** POST /api/menu — 创建菜单 */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions()
  async create(@Body() body: Record<string, unknown>) {
    return this.db.model('menus').create({ data: body });
  }

  /** PUT /api/menu/:id — 更新菜单 */
  @Put(':id')
  @Permissions()
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.db.model('menus').update({ where: { id }, data: body });
  }

  /** DELETE /api/menu/:id — 递归删除菜单及所有子菜单 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions()
  async remove(@Param('id') id: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // 递归收集所有后代菜单 ID
      const allIds = await this.collectDescendantIds(tx, id);
      allIds.push(id);

      // 删除关联和菜单
      await tx.model('roleMenus').deleteMany({ where: { menuId: { in: allIds } } });
      await tx.model('menus').deleteMany({ where: { id: { in: allIds } } });
    });
  }

  /** 递归收集所有后代菜单 ID */
  private async collectDescendantIds(
    tx: DatabaseAdapter,
    parentId: string,
  ): Promise<string[]> {
    const children = (await tx.model('menus').findMany({
      where: { parentId },
      select: { id: true },
    })) as Array<{ id: string }>;

    const result: string[] = [];
    for (const child of children) {
      result.push(child.id);
      const grandChildren = await this.collectDescendantIds(tx, child.id);
      result.push(...grandChildren);
    }
    return result;
  }

  /** PUT /api/menu/:id/sort — 更新菜单排序 */
  @Put(':id/sort')
  @Permissions()
  async updateSort(
    @Param('id') id: string,
    @Body() body: { sortOrder: number },
  ) {
    return this.db.model('menus').update({
      where: { id },
      data: { sortOrder: body.sortOrder },
    });
  }
}
