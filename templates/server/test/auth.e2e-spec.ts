/**
 * Auth controller e2e tests.
 *
 * Covers:
 * - POST /api/authorize/login  (happy path, wrong password, missing fields)
 * - GET  /api/authorize/me     (with valid token, without token)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('POST /api/authorize/login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp([
      { id: 'u1', username: 'admin', password: 'Admin@123' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns token on valid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ username: 'admin', password: 'Admin@123' })
      .expect(200);

    expect(res.body).toMatchObject({
      userId: 'u1',
      token: expect.any(String),
      expires: expect.any(Number),
    });
    expect(res.body.token.length).toBeGreaterThan(10);
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ username: 'admin', password: 'wrong' })
      .expect(401);

    expect(res.body.message).toMatch(/illegal_password/);
  });

  it('returns 400 when username is missing', async () => {
    await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ password: 'Admin@123' })
      .expect(400);
  });

  it('returns 400 when password is missing', async () => {
    await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ username: 'admin' })
      .expect(400);
  });
});

describe('GET /api/authorize/me', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp([
      { id: 'u1', username: 'admin', password: 'Admin@123' },
    ]);

    // Obtain a real token via login
    const loginRes = await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ username: 'admin', password: 'Admin@123' });
    token = loginRes.body.token as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns user info with valid Bearer token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/authorize/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      user: expect.objectContaining({ id: 'u1', username: 'admin' }),
    });
  });

  it('returns 401 without Authorization header', async () => {
    await request(app.getHttpServer())
      .get('/api/authorize/me')
      .expect(401);
  });

  it('returns 401 with an invalid token', async () => {
    await request(app.getHttpServer())
      .get('/api/authorize/me')
      .set('Authorization', 'Bearer totally.invalid.token')
      .expect(401);
  });
});

describe('Login → Me full flow', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp([
      { id: 'u2', username: 'alice', password: 'Alice@456' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('login then /me returns consistent userId', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/authorize/login')
      .send({ username: 'alice', password: 'Alice@456' })
      .expect(200);

    const { userId, token } = loginRes.body as { userId: string; token: string };

    const meRes = await request(app.getHttpServer())
      .get('/api/authorize/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // /me returns an Authentication object; the user id should match
    expect((meRes.body as { user?: { id: string } }).user?.id ?? meRes.body.id).toBe(userId);
  });
});
