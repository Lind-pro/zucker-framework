/**
 * Role API e2e tests.
 *
 * NOTE: Like user.e2e-spec.ts, roles are a service-layer primitive in
 * @zucker/auth — there is no pre-built RoleController shipped with the
 * framework.  This spec registers an inline RoleController that application
 * code would produce, wired into the same InMemoryDatabaseAdapter.
 *
 * Covers:
 * - POST /api/roles/_query    (paginated list)
 * - POST /api/roles           (create, requires roles:add)
 * - GET  /api/roles/:id       (find by id)
 * - PUT  /api/roles/:id       (update with optional permissionIds, requires roles:update)
 * - DELETE /api/roles/:id     (delete, requires roles:delete)
 * - unauthenticated → 401 on every endpoint
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
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ZuckerCrudModule } from '@zucker/crud';
import {
  ZuckerAuthModule,
  AuthorizationController,
  AUTHENTICATION_MANAGER,
  JwtAuthGuard,
  PermissionsGuard,
  Permissions,
} from '@zucker/auth';
import type { AuthenticationManagerLike } from '@zucker/auth';
import { HttpExceptionFilter } from '@zucker/common';
import { InMemoryDatabaseAdapter } from './helpers/in-memory-db';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

interface CreateRoleDto {
  name: string;
  code: string;
  description?: string;
  /** List of permission IDs to assign to the role */
  permissionIds?: string[];
}

interface UpdateRoleDto {
  name?: string;
  code?: string;
  description?: string;
  permissionIds?: string[];
}

interface QueryDto {
  pageIndex?: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Inline RoleController
// ---------------------------------------------------------------------------

@Controller('roles')
class RoleController {
  constructor(
    private readonly db: { model: (name: string) => {
      findMany: (args?: object) => Promise<Record<string, unknown>[]>;
      findUnique: (args: object) => Promise<Record<string, unknown> | null>;
      create: (args: object) => Promise<Record<string, unknown>>;
      update: (args: object) => Promise<Record<string, unknown>>;
      delete: (args: object) => Promise<Record<string, unknown>>;
      deleteMany: (args?: object) => Promise<{ count: number }>;
    }},
  ) {}

  @Post('_query')
  @Permissions([])          // login required
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryDto) {
    const { pageIndex = 0, pageSize = 20 } = body;
    const all = await this.db.model('roles').findMany();
    const total = all.length;
    const data = all.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    return { data, total, pageIndex, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  @Post()
  @Permissions(['roles:add'])
  async create(@Body() body: CreateRoleDto) {
    const { permissionIds = [], ...roleData } = body;
    const id = `role-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const role = await this.db.model('roles').create({
      data: { id, ...roleData, createdAt: new Date().toISOString() },
    });
    // Assign permissions
    for (const permissionId of permissionIds) {
      await this.db.model('rolePermissions').create({
        data: { roleId: id, permissionId },
      });
    }
    return role;
  }

  @Get(':id')
  @Permissions([])          // login required
  async findOne(@Param('id') id: string) {
    const role = await this.db.model('roles').findUnique({ where: { id } });
    if (!role) throw new NotFoundException(`Role "${id}" not found`);
    // Attach permission IDs for convenience
    const links = await this.db.model('rolePermissions').findMany({ where: { roleId: id } });
    return { ...role, permissionIds: links.map((l) => l['permissionId']) };
  }

  @Put(':id')
  @Permissions(['roles:update'])
  async update(@Param('id') id: string, @Body() body: UpdateRoleDto) {
    const role = await this.db.model('roles').findUnique({ where: { id } });
    if (!role) throw new NotFoundException(`Role "${id}" not found`);

    const { permissionIds, ...roleData } = body;
    const updated = await this.db.model('roles').update({ where: { id }, data: roleData });

    // Re-sync permissions if provided
    if (permissionIds !== undefined) {
      await this.db.model('rolePermissions').deleteMany({ where: { roleId: id } });
      for (const permissionId of permissionIds) {
        await this.db.model('rolePermissions').create({
          data: { roleId: id, permissionId },
        });
      }
    }

    const links = await this.db.model('rolePermissions').findMany({ where: { roleId: id } });
    return { ...updated, permissionIds: links.map((l) => l['permissionId']) };
  }

  @Delete(':id')
  @Permissions(['roles:delete'])
  async remove(@Param('id') id: string) {
    const role = await this.db.model('roles').findUnique({ where: { id } });
    if (!role) throw new NotFoundException(`Role "${id}" not found`);
    await this.db.model('rolePermissions').deleteMany({ where: { roleId: id } });
    await this.db.model('roles').delete({ where: { id } });
    return { deleted: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATABASE_ADAPTER_TOKEN = 'DATABASE_ADAPTER';

async function createRoleTestApp(options: {
  authUsers?: Array<{ id: string; username: string; password: string }>;
  dbRoles?: Array<Record<string, unknown>>;
  dbRolePermissions?: Array<Record<string, unknown>>;
  userPermissions?: Array<Record<string, unknown>>;
} = {}): Promise<INestApplication> {
  const { authUsers = [], dbRoles = [], dbRolePermissions = [], userPermissions = [] } = options;

  const adapter = new InMemoryDatabaseAdapter();
  if (dbRoles.length)           adapter.seed('roles', dbRoles);
  if (dbRolePermissions.length) adapter.seed('rolePermissions', dbRolePermissions);
  if (userPermissions.length)   adapter.seed('userPermissions', userPermissions);

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
    controllers: [AuthorizationController, RoleController],
    providers: [
      { provide: AUTHENTICATION_MANAGER, useValue: authManager },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      // Expose the adapter under the raw token so RoleController can inject it.
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
// Tests: POST /api/roles/_query
// ---------------------------------------------------------------------------

describe('POST /api/roles/_query', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createRoleTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbRoles: [
        { id: 'r1', name: 'Admin', code: 'admin', description: 'System administrator' },
        { id: 'r2', name: 'Viewer', code: 'viewer', description: 'Read-only access' },
        { id: 'r3', name: 'Editor', code: 'editor', description: 'Can edit records' },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns paginated role list with valid token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/roles/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(200);

    expect(res.body).toMatchObject({ total: 3, pageIndex: 0 });
    expect(res.body.data).toHaveLength(3);
  });

  it('respects pageSize', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/roles/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.totalPages).toBe(2);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .post('/api/roles/_query')
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/roles  (create)
// ---------------------------------------------------------------------------

describe('POST /api/roles', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createRoleTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'roles:add' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('creates a role when caller has roles:add permission', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Moderator', code: 'moderator', description: 'Forum moderator' })
      .expect(201);

    expect(res.body).toMatchObject({ name: 'Moderator', code: 'moderator' });
    expect(res.body.id).toBeDefined();
  });

  it('creates a role with initial permissionIds', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'SuperRole',
        code: 'super',
        permissionIds: ['users:add', 'users:delete'],
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
  });

  it('returns 403 when caller lacks roles:add permission', async () => {
    await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ name: 'Hack', code: 'hack' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .post('/api/roles')
      .send({ name: 'Anon', code: 'anon' })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/roles/:id
// ---------------------------------------------------------------------------

describe('GET /api/roles/:id', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createRoleTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbRoles: [
        { id: 'r-read', name: 'ReadRole', code: 'read', description: 'Read access' },
      ],
      dbRolePermissions: [
        { roleId: 'r-read', permissionId: 'articles:view' },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns role detail including permissionIds', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/roles/r-read')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({ id: 'r-read', name: 'ReadRole' });
    expect(res.body.permissionIds).toContain('articles:view');
  });

  it('returns 404 for unknown role id', async () => {
    await request(app.getHttpServer())
      .get('/api/roles/nonexistent')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .get('/api/roles/r-read')
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: PUT /api/roles/:id  (update)
// ---------------------------------------------------------------------------

describe('PUT /api/roles/:id', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createRoleTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      dbRoles: [
        { id: 'r-upd', name: 'OldName', code: 'old', description: 'Before update' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'roles:update' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('updates role name and syncs permissions', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/roles/r-upd')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'NewName', permissionIds: ['users:view', 'roles:view'] })
      .expect(200);

    expect(res.body).toMatchObject({ id: 'r-upd', name: 'NewName' });
    expect(res.body.permissionIds).toEqual(
      expect.arrayContaining(['users:view', 'roles:view']),
    );
  });

  it('returns 403 when caller lacks roles:update permission', async () => {
    await request(app.getHttpServer())
      .put('/api/roles/r-upd')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ name: 'Hacked' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .put('/api/roles/r-upd')
      .send({ name: 'Anon' })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/roles/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/roles/:id', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createRoleTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      dbRoles: [
        { id: 'r-del', name: 'DeleteMe', code: 'delete-me' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'roles:delete' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('returns 403 when caller lacks roles:delete permission', async () => {
    await request(app.getHttpServer())
      .delete('/api/roles/r-del')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
  });

  it('deletes role when caller has roles:delete permission', async () => {
    await request(app.getHttpServer())
      .delete('/api/roles/r-del')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('returns 404 when deleting already-deleted role', async () => {
    await request(app.getHttpServer())
      .delete('/api/roles/r-del')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .delete('/api/roles/r-del')
      .expect(401);
  });
});
