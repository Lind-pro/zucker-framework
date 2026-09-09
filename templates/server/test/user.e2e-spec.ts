/**
 * User API e2e tests.
 *
 * NOTE: The zucker-framework does not ship a pre-built UserController — the
 * UserService lives in @zucker-framework/auth as a service-layer primitive.  This spec
 * registers a minimal inline UserController (identical to what application
 * code would write) so that the HTTP surface can be exercised end-to-end
 * using the same InMemoryDatabaseAdapter as the auth spec.
 *
 * Covers:
 * - POST /api/users/_query    (paginated list, unauthenticated → 401)
 * - POST /api/users           (create, requires users:add permission → 403)
 * - GET  /api/users/:id       (find by id, unauthenticated → 401)
 * - PUT  /api/users/:id       (update, requires users:update permission → 403)
 * - DELETE /api/users/:id     (delete, requires users:delete permission → 403)
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
import { ZuckerCrudModule } from '@zucker-framework/crud';
import {
  ZuckerAuthModule,
  AuthorizationController,
  AUTHENTICATION_MANAGER,
  JwtAuthGuard,
  PermissionsGuard,
  UserService,
  Permissions,
  Public,
} from '@zucker-framework/auth';
import type { AuthenticationManagerLike } from '@zucker-framework/auth';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { InMemoryDatabaseAdapter } from './helpers/in-memory-db';

// ---------------------------------------------------------------------------
// Inline UserController — mirrors what application code would produce.
// ---------------------------------------------------------------------------

interface CreateUserDto {
  username: string;
  password: string;
  name?: string;
  status?: number;
}

interface UpdateUserDto {
  name?: string;
  status?: number;
}

interface QueryDto {
  pageIndex?: number;
  pageSize?: number;
  filter?: Record<string, unknown>;
}

@Controller('users')
class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('_query')
  @Permissions([])          // login required, no specific permission needed for list
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryDto) {
    const { pageIndex = 0, pageSize = 20 } = body;
    const all = await this.userService.findUsers();
    const total = all.length;
    const data = all.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    return { data, total, pageIndex, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  @Post()
  @Permissions(['users:add'])
  async create(@Body() body: CreateUserDto) {
    return this.userService.addUser(body);
  }

  @Get(':id')
  @Permissions([])          // login required
  async findOne(@Param('id') id: string) {
    const user = await this.userService.findById(id);
    if (!user) throw new NotFoundException(`User "${id}" not found`);
    const { password, salt, ...safe } = user;
    return safe;
  }

  @Put(':id')
  @Permissions(['users:update'])
  async update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    const user = await this.userService.findById(id);
    if (!user) throw new NotFoundException(`User "${id}" not found`);
    return this.userService.saveUser({ ...user, ...body });
  }

  @Delete(':id')
  @Permissions(['users:delete'])
  async remove(@Param('id') id: string) {
    const deleted = await this.userService.deleteUser(id);
    if (!deleted) throw new NotFoundException(`User "${id}" not found`);
    return { deleted: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal NestJS app with the UserController and seeded DB data. */
async function createUserTestApp(options: {
  /** Users that can log in (plain passwords — for AuthenticationManager). */
  authUsers?: Array<{ id: string; username: string; password: string }>;
  /** Pre-seeded DB rows for the 'users' model (encoded passwords etc.). */
  dbUsers?: Array<Record<string, unknown>>;
  /** Pre-seeded userPermissions rows to grant callerUser specific permissions. */
  userPermissions?: Array<Record<string, unknown>>;
} = {}): Promise<INestApplication> {
  const { authUsers = [], dbUsers = [], userPermissions = [] } = options;

  const adapter = new InMemoryDatabaseAdapter();

  // Seed DB tables so the in-memory adapter is pre-populated.
  if (dbUsers.length) adapter.seed('users', dbUsers);
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
    controllers: [AuthorizationController, UserController],
    providers: [
      { provide: AUTHENTICATION_MANAGER, useValue: authManager },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  })
    .overrideProvider('DATABASE_ADAPTER')
    .useValue(adapter)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

/** Log in and return a Bearer token. */
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
// Tests: POST /api/users/_query
// ---------------------------------------------------------------------------

describe('POST /api/users/_query', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createUserTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbUsers: [
        { id: 'u1', username: 'alice', name: 'Alice', status: 1, password: 'hashed', salt: '' },
        { id: 'u2', username: 'bob',   name: 'Bob',   status: 1, password: 'hashed', salt: '' },
        { id: 'u3', username: 'carol', name: 'Carol', status: 0, password: 'hashed', salt: '' },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns paginated list with valid token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(200);

    expect(res.body).toMatchObject({
      total: 3,
      pageIndex: 0,
      pageSize: 10,
    });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(3);
  });

  it('respects pageSize / pageIndex pagination', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 0, pageSize: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it('returns second page correctly', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users/_query')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageIndex: 1, pageSize: 2 })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
  });

  it('returns 401 without Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/api/users/_query')
      .send({ pageIndex: 0, pageSize: 10 })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/users  (create)
// ---------------------------------------------------------------------------

describe('POST /api/users', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createUserTestApp({
      authUsers: [
        { id: 'admin-1', username: 'admin',    password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer',  password: 'Viewer@123' },
      ],
      // Grant admin the users:add permission directly.
      userPermissions: [
        { userId: 'admin-1', permissionId: 'users:add' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('creates a user when caller has users:add permission', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'newuser', password: 'NewUser@123', name: 'New User' })
      .expect(201);

    expect(res.body).toMatchObject({ username: 'newuser' });
    expect(res.body.id).toBeDefined();
    // Password must not be returned in plain text
    expect(res.body.password).not.toBe('NewUser@123');
  });

  it('returns 403 when caller lacks users:add permission', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ username: 'hacker', password: 'Hacker@123' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .send({ username: 'anon', password: 'Anon@123' })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/users/:id
// ---------------------------------------------------------------------------

describe('GET /api/users/:id', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createUserTestApp({
      authUsers: [{ id: 'admin-1', username: 'admin', password: 'Admin@123' }],
      dbUsers: [
        { id: 'u-100', username: 'testuser', name: 'Test', status: 1, password: 'hashed', salt: '' },
      ],
    });
    token = await loginToken(app, 'admin', 'Admin@123');
  });

  afterAll(() => app.close());

  it('returns user details for a valid id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/users/u-100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({ id: 'u-100', username: 'testuser' });
    // Password fields must be stripped by the controller
    expect(res.body.password).toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    await request(app.getHttpServer())
      .get('/api/users/does-not-exist')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .get('/api/users/u-100')
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: PUT /api/users/:id  (update)
// ---------------------------------------------------------------------------

describe('PUT /api/users/:id', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createUserTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      dbUsers: [
        { id: 'u-200', username: 'editme', name: 'Before', status: 1, password: 'hashed', salt: '' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'users:update' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('updates user name when caller has users:update permission', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/users/u-200')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'After' })
      .expect(200);

    expect(res.body).toMatchObject({ username: 'editme', name: 'After' });
  });

  it('returns 403 when caller lacks users:update permission', async () => {
    await request(app.getHttpServer())
      .put('/api/users/u-200')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ name: 'Hacked' })
      .expect(403);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .put('/api/users/u-200')
      .send({ name: 'Anon' })
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/users/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/users/:id', () => {
  let app: INestApplication;
  let adminToken: string;
  let noPermToken: string;

  beforeAll(async () => {
    app = await createUserTestApp({
      authUsers: [
        { id: 'admin-1',  username: 'admin',  password: 'Admin@123' },
        { id: 'viewer-1', username: 'viewer', password: 'Viewer@123' },
      ],
      dbUsers: [
        { id: 'u-300', username: 'deleteme', status: 1, password: 'hashed', salt: '' },
      ],
      userPermissions: [
        { userId: 'admin-1', permissionId: 'users:delete' },
      ],
    });
    adminToken  = await loginToken(app, 'admin',  'Admin@123');
    noPermToken = await loginToken(app, 'viewer', 'Viewer@123');
  });

  afterAll(() => app.close());

  it('returns 403 when caller lacks users:delete permission', async () => {
    await request(app.getHttpServer())
      .delete('/api/users/u-300')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
  });

  it('deletes user when caller has users:delete permission', async () => {
    await request(app.getHttpServer())
      .delete('/api/users/u-300')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('returns 404 when deleting already-deleted user', async () => {
    await request(app.getHttpServer())
      .delete('/api/users/u-300')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 401 without token', async () => {
    await request(app.getHttpServer())
      .delete('/api/users/u-300')
      .expect(401);
  });
});
