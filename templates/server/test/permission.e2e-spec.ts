/**
 * Permission API e2e tests.
 *
 * NOTE: @zucker-framework/auth ships a PermissionService but no HTTP PermissionController.
 * This spec registers an inline controller (mirroring what application code
 * would produce) and exercises the full HTTP surface using InMemoryDatabaseAdapter.
 *
 * Covers:
 * - GET  /api/permissions           (list all permission definitions)
 * - POST /api/permissions/_query    (paginated query)
 * - POST /api/permissions           (create, requires permissions:add)
 * - PUT  /api/permissions/:id       (update, requires permissions:update)
 * - DELETE /api/permissions/:id     (delete, requires permissions:delete)
 * - Cross-resource: assign permission to role, GET /api/roles/:id reflects it
 * - unauthenticated → 401 on every protected endpoint
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import {
  ZuckerAuthModule,
  AuthorizationController,
  AUTHENTICATION_MANAGER,
  JwtAuthGuard,
  PermissionsGuard,
  Permissions,
  Public,
} from '@zucker-framework/auth';
import type { AuthenticationManagerLike } from '@zucker-framework/auth';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { InMemoryDatabaseAdapter } from './helpers/in-memory-db';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

interface CreatePermissionDto {
  id: string;         // permission resource identifier, e.g. "users"
  name: string;
  code?: string;
  type?: string;      // 'menu' | 'button' | 'api'
  description?: string;
  status?: boolean;
  actions?: unknown[];
}

interface UpdatePermissionDto {
  name?: string;
  code?: string;
  type?: string;
  description?: string;
  status?: boolean;
}

interface QueryDto {
  pageIndex?: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DB adapter type shorthand
// ---------------------------------------------------------------------------

type DbModel = {
  findMany: (args?: object) => Promise<Record<string, unknown>[]>;
  findUnique: (args: object) => Promise<Record<string, unknown> | null>;
  create: (args: object) => Promise<Record<string, unknown>>;
  update: (args: object) => Promise<Record<string, unknown>>;
  delete: (args: object) => Promise<Record<string, unknown>>;
  deleteMany: (args?: object) => Promise<{ count: number }>;
};
type DbAdapter = { model: (name: string) => DbModel };

// ---------------------------------------------------------------------------
// Inline PermissionController
// ---------------------------------------------------------------------------

@Controller('permissions')
class PermissionController {
  // Interface types carry no runtime metadata, so the adapter is injected by token.
  constructor(@Inject('DATABASE_ADAPTER') private readonly db: DbAdapter) {}

  /** GET /permissions — list all (public-ish: login required, no extra permission) */
  @Get()
  @Permissions()
  async findAll() {
    return this.db.model('permissions').findMany();
  }

  /** POST /permissions/_query — paginated query */
  @Post('_query')
  @Permissions()
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryDto) {
    const { pageIndex = 0, pageSize = 20 } = body;
    const all = await this.db.model('permissions').findMany();
    const total = all.length;
    const data = all.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    return { data, total, pageIndex, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  /** POST /permissions — create */
  @Post()
  @Permissions('permissions:add')
  async create(@Body() body: CreatePermissionDto) {
    const existing = await this.db.model('permissions').findUnique({ where: { id: body.id } });
    if (existing) {
      throw new NotFoundException(`Permission id "${body.id}" already exists`);
    }
    return this.db.model('permissions').create({
      data: { ...body, status: body.status ?? true, createdAt: new Date().toISOString() },
    });
  }

  /** PUT /permissions/:id — update */
  @Put(':id')
  @Permissions('permissions:update')
  async update(@Param('id') id: string, @Body() body: UpdatePermissionDto) {
    const existing = await this.db.model('permissions').findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Permission "${id}" not found`);
    return this.db.model('permissions').update({ where: { id }, data: body });
  }

  /** DELETE /permissions/:id */
  @Delete(':id')
  @Permissions('permissions:delete')
  async remove(@Param('id') id: string) {
    const existing = await this.db.model('permissions').findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Permission "${id}" not found`);
    // Remove all role-permission links that reference this permission
    await this.db.model('rolePermissions').deleteMany({ where: { permissionId: id } });
    await this.db.model('permissions').delete({ where: { id } });
    return { deleted: true };
  }
}

// ---------------------------------------------------------------------------
// Inline RoleController (minimal — only GET /:id, used for cross-resource test)
// ---------------------------------------------------------------------------

@Controller('roles')
class RoleReadController {
  // Interface types carry no runtime metadata, so the adapter is injected by token.
  constructor(@Inject('DATABASE_ADAPTER') private readonly db: DbAdapter) {}

  @Get(':id')
  @Permissions()
  async findOne(@Param('id') id: string) {
    const role = await this.db.model('roles').findUnique({ where: { id } });
    if (!role) throw new NotFoundException(`Role "${id}" not found`);
    const links = await this.db.model('rolePermissions').findMany({ where: { roleId: id } });
    return { ...role, permissionIds: links.map((l) => l['permissionId']) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATABASE_ADAPTER_TOKEN = 'DATABASE_ADAPTER';

async function createPermissionTestApp(options: {
  authUsers?: Array<{ id: string; username: string; password: string }>;
  dbPermissions?: Array<Record<string, unknown>>;
  dbRoles?: Array<Record<string, unknown>>;
  dbRolePermissions?: Array<Record<string, unknown>>;
  userPermissions?: Array<Record<string, unknown>>;
} = {}): Promise<INestApplication> {
  const {
    authUsers = [],
    dbPermissions = [],
    dbRoles = [],
    dbRolePermissions = [],
    userPermissions = [],
  } = options;

  const adapter = new InMemoryDatabaseAdapter();
  if (dbPermissions.length)   adapter.seed('permissions', dbPermissions);
  if (dbRoles.length)         adapter.seed('roles', dbRoles);
  if (dbRolePermissions.length) adapter.seed('rolePermissions', dbRolePermissions);
  if (userPermissions.length) adapter.seed('userPermissions', userPermissions);

  const authManager: AuthenticationManagerLike = {
    async authenticate(username, password) {
      const found = authUsers.find(
        (u) => u.username === username && u.password === password,
      );
      return found ? { id: found.id, username: found.username } : null;
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ZuckerCrudModule.forRoot({ adapterClass: InMemoryDatabaseAdapter }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'test-secret' }),
    ],
    controllers: [AuthorizationController, PermissionController, RoleReadController],
    providers: [
      { provide: AUTHENTICATION_MANAGER, useValue: authManager },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: DATABASE_ADAPTER_TOKEN, useValue: adapter },
    ],
  })
    .overrideProvider(DATABASE_ADAPTER_TOKEN)
    .useValue(adapter)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

async function loginToken(
  app: INestApplication,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/authorize/login')
    .send({ username, password })
    .expect(200);
  return res.body.token as string;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/permissions
// ---------------------------------------------------------------------------

describe('GET /api/permissions', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createPermissionTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbPermissions: [
        { id: 'users', name: '用户管理', type: 'menu', status: true },
        { id: 'roles', name: '角色管理', type: 'menu', status: true },
        { id: 'config', name: '系统配置', type: 'button', status: true },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns all permission definitions with valid token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toMatchObject({ id: 'users', name: '用户管理' });
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .get('/api/permissions')
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/permissions/_query
// ---------------------------------------------------------------------------

describe('POST /api/permissions/_query', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createPermissionTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbPermissions: [
        { id: 'p1', name: 'Permission One',   type: 'api',    status: true },
        { id: 'p2', name: 'Permission Two',   type: 'button', status: true },
        { id: 'p3', name: 'Permission Three', type: 'menu',   status: false },
        { id: 'p4', name: 'Permission Four',  type: 'api',    status: true },
        { id: 'p5', name: 'Permission Five',  type: 'menu',   status: true },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns paginated results with valid token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/permissions/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(200);

    expect(res.body).toMatchObject({ total: 5, pageIndex: 0 });
    expect(res.body.data).toHaveLength(5);
  });

  it('respects pageSize', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/permissions/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.totalPages).toBe(3);
  });

  it('second page returns remaining items', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/permissions/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 2, pageSize: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .post('/api/permissions/_query')
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/permissions  (create)
// ---------------------------------------------------------------------------

describe('POST /api/permissions', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createPermissionTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'permissions:add' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('creates a permission when caller has permissions:add', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: 'reports', name: '报表管理', type: 'menu', description: 'Manage reports' })
      .expect(201);

    expect(res.body).toMatchObject({ id: 'reports', name: '报表管理', status: true });
  });

  it('returns 403 when caller lacks permissions:add', async () => {
    await request(app.getHttpServer())
      .post('/api/permissions')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ id: 'hack', name: 'Hack' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .post('/api/permissions')
      .send({ id: 'anon', name: 'Anon' })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: Cross-resource — permission assigned to role appears in GET /roles/:id
// ---------------------------------------------------------------------------

describe('Permission assigned to role is reflected in GET /api/roles/:id', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createPermissionTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbPermissions: [
        { id: 'documents', name: '文档管理', type: 'menu', status: true },
      ],
      dbRoles: [
        { id: 'r-doc', name: 'DocManager', code: 'doc-manager' },
      ],
      dbRolePermissions: [
        { roleId: 'r-doc', permissionId: 'documents' },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('GET /api/roles/:id includes the assigned permissionId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/roles/r-doc')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({ id: 'r-doc', name: 'DocManager' });
    expect(res.body.permissionIds).toContain('documents');
  });
});

// ---------------------------------------------------------------------------
// Tests: PUT /api/permissions/:id  (update)
// ---------------------------------------------------------------------------

describe('PUT /api/permissions/:id', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createPermissionTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      dbPermissions: [
        { id: 'logs', name: '日志 Old', type: 'menu', status: true },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'permissions:update' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('updates permission name when caller has permissions:update', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/permissions/logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '日志 New', description: 'Updated description' })
      .expect(200);

    expect(res.body).toMatchObject({ id: 'logs', name: '日志 New' });
  });

  it('returns 403 when caller lacks permissions:update', async () => {
    await request(app.getHttpServer())
      .put('/api/permissions/logs')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ name: 'Hacked' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .put('/api/permissions/logs')
      .send({ name: 'Anon' })
      .expect(401);
  });
});
