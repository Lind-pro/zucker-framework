import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from '@zucker/common';
import { UserService } from '@zucker/auth';
import type { DatabaseAdapter } from '@zucker/core';
import { DATABASE_ADAPTER } from '@zucker/crud';
import { AppModule } from './app.module';

async function bootstrap() {
  const startTime = performance.now();

  const app = await NestFactory.create(AppModule);
  const bootstrapTime = performance.now() - startTime;
  Logger.log(`NestJS module init completed in ${bootstrapTime.toFixed(0)}ms`, 'Bootstrap');

  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:4201',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      // NOTE: whitelist 和 forbidNonWhitelisted 需要 class-validator DTO 才有效。
      // 当前 controller 大多使用 inline interface，启用 whitelist 会导致 body 被清空。
      // TODO: 迁移到 DTO class 后重新启用 whitelist: true, forbidNonWhitelisted: true
      transform: true,
    }),
  );

  const port = process.env.PORT || 4200;
  await app.listen(port);

  // ─── 系统初始化：每个部分独立检查，已存在则跳过 ─────────────────────
  try {
    const userService = app.get(UserService);
    const db = app.get<DatabaseAdapter>(DATABASE_ADAPTER);

    // 1. 确保 superadmin 角色存在
    let superadminRoleId: string;
    const existingRole = await db.model('roles').findUnique({ where: { name: 'superadmin' } }).catch(() => null) as { id: string } | null;
    if (!existingRole) {
      const role = await db.model('roles').create({
        data: { name: 'superadmin', description: '超级管理员' },
      }) as { id: string };
      superadminRoleId = role.id;
      Logger.log('superadmin 角色已创建', 'Bootstrap');
    } else {
      superadminRoleId = existingRole.id;
    }

    // 2. 确保 admin 用户存在
    const admin = await userService.findByUsername('admin');
    if (!admin) {
      const authPkg = await import('@zucker/auth');
      userService.setUsernameValidator(new authPkg.UsernameValidator({ reservedNames: [] }));
      userService.setPasswordValidator(new authPkg.PasswordValidator({
        minLength: 6, requireUppercase: false, requireSpecialChar: false,
      }));
      const created = await userService.addUser({
        username: 'admin',
        password: 'admin123',
        name: '系统管理员',
        status: true,
        typeId: 'default',
      });
      userService.setUsernameValidator(new authPkg.UsernameValidator());
      userService.setPasswordValidator(new authPkg.PasswordValidator());

      // 分配 superadmin 角色
      await db.model('userRoles').create({
        data: { userId: created.id, roleId: superadminRoleId },
      }).catch(() => {}); // 可能已存在

      Logger.log('默认管理员已创建: admin / admin123 — 请尽快修改密码', 'Bootstrap');
    }

    // 3. 确保默认菜单存在（独立于用户创建）
    const existingMenus = await db.model('menus').findMany({}).catch(() => []) as unknown[];
    if (!existingMenus || (existingMenus as unknown[]).length === 0) {
      const defaultMenus = [
        { name: '仪表盘', path: '/dashboard', icon: 'DashboardOutlined', sortOrder: 0, status: true, permissions: [] as string[] },
        { name: '用户管理', path: '/users', icon: 'UserOutlined', sortOrder: 1, status: true, permissions: [] as string[] },
        { name: '角色管理', path: '/roles', icon: 'TeamOutlined', sortOrder: 2, status: true, permissions: [] as string[] },
        { name: '权限管理', path: '/permissions', icon: 'LockOutlined', sortOrder: 3, status: true, permissions: [] as string[] },
        { name: '菜单管理', path: '/menu', icon: 'MenuOutlined', sortOrder: 4, status: true, permissions: [] as string[] },
        { name: '数据字典', path: '/dictionary', icon: 'BookOutlined', sortOrder: 5, status: true, permissions: [] as string[] },
        { name: '系统配置', path: '/config', icon: 'SettingOutlined', sortOrder: 6, status: true, permissions: [] as string[] },
        { name: '积分管理', path: '/credit', icon: 'MoneyCollectOutlined', sortOrder: 7, status: true, permissions: [] as string[] },
        { name: '访问日志', path: '/access-log', icon: 'FileTextOutlined', sortOrder: 8, status: true, permissions: [] as string[] },
        { name: '通知管理', path: '/notification/template', icon: 'BellOutlined', sortOrder: 9, status: true, permissions: [] as string[] },
        { name: '租户管理', path: '/tenant', icon: 'ApartmentOutlined', sortOrder: 10, status: true, permissions: [] as string[] },
        { name: '国际化', path: '/i18n', icon: 'GlobalOutlined', sortOrder: 11, status: true, permissions: [] as string[] },
        { name: '表单引擎', path: '/form-engine', icon: 'FormOutlined', sortOrder: 12, status: true, permissions: [] as string[] },
      ];
      for (const menu of defaultMenus) {
        await db.model('menus').create({ data: menu }).catch(() => {});
      }
      Logger.log(`默认菜单已创建: ${defaultMenus.length} 项`, 'Bootstrap');
    }
  } catch (err) {
    Logger.warn(
      `系统初始化跳过: ${err instanceof Error ? err.message : String(err)}`,
      'Bootstrap',
    );
  }

  const totalTime = performance.now() - startTime;
  Logger.log(
    `Server ready on http://localhost:${port} (total: ${totalTime.toFixed(0)}ms)`,
    'Bootstrap',
  );
}

bootstrap();
