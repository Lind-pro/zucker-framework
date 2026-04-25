import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OwnCreatedDataAccessHandler } from './own-created.handler';
import { DefaultDataAccessType } from './data-access-config';
import type { DataAccessConfig, OwnCreatedDataAccessConfig } from './data-access-config';
import type { AuthorizingContext } from './data-access-handler';
import { DefaultAuthentication } from '../authentication/default-authentication';

// Suppress NestJS Logger output
vi.mock('@nestjs/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/common')>();
  return {
    ...actual,
    Logger: class {
      log = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
  };
});

function makeContext(userId: string, action: string, resourceId?: string): AuthorizingContext {
  return {
    authentication: new DefaultAuthentication({ user: { id: userId, username: userId } }),
    permissionId: 'test',
    action,
    dataType: 'testModel',
    request: {
      method: action === 'query' ? 'GET' : 'POST',
      params: resourceId ? { id: resourceId } : {},
      query: {},
      body: {},
      path: '/test',
    },
  };
}

describe('OwnCreatedDataAccessHandler', () => {
  let handler: OwnCreatedDataAccessHandler;
  let mockModel: { findUnique: ReturnType<typeof vi.fn> };
  let mockDb: any;

  beforeEach(() => {
    mockModel = { findUnique: vi.fn() };
    mockDb = { model: vi.fn().mockReturnValue(mockModel) };
    handler = new OwnCreatedDataAccessHandler(mockDb);
  });

  const ownConfig: OwnCreatedDataAccessConfig = {
    action: 'query',
    type: DefaultDataAccessType.OWN_CREATED,
  };

  it('isSupport returns true for OWN_CREATED type', () => {
    expect(handler.isSupport(ownConfig)).toBe(true);
  });

  it('isSupport returns false for other types', () => {
    const other: DataAccessConfig = {
      action: 'query',
      type: DefaultDataAccessType.DENY_FIELDS,
    };
    expect(handler.isSupport(other)).toBe(false);
  });

  it('returns filter result for query action', async () => {
    const ctx = makeContext('u1', 'query');
    const result = await handler.handle(ownConfig, ctx);
    expect(result.allowed).toBe(true);
    expect(result.filterConditions).toHaveLength(1);
    expect(result.filterConditions![0]).toEqual({
      column: 'creatorId',
      termType: 'eq',
      value: 'u1',
    });
  });

  it('returns filter result for get action', async () => {
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'get' };
    const ctx = makeContext('u1', 'get');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(true);
    expect(result.filterConditions).toBeDefined();
  });

  it('uses custom creatorField', async () => {
    const config: OwnCreatedDataAccessConfig = {
      ...ownConfig,
      creatorField: 'authorId',
    };
    const ctx = makeContext('u1', 'query');
    const result = await handler.handle(config, ctx);
    expect(result.filterConditions![0].column).toBe('authorId');
  });

  it('allows mutation without specific resource id', async () => {
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'update' };
    const ctx = makeContext('u1', 'update');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(true);
  });

  it('allows mutation when user is the owner', async () => {
    mockModel.findUnique.mockResolvedValue({ creatorId: 'u1' });
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'update' };
    const ctx = makeContext('u1', 'update', 'res1');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(true);
  });

  it('denies mutation when user is not the owner', async () => {
    mockModel.findUnique.mockResolvedValue({ creatorId: 'other' });
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'update' };
    const ctx = makeContext('u1', 'update', 'res1');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(false);
  });

  it('denies mutation when resource not found', async () => {
    mockModel.findUnique.mockResolvedValue(null);
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'delete' };
    const ctx = makeContext('u1', 'delete', 'res1');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(false);
  });

  it('denies on db error', async () => {
    mockModel.findUnique.mockRejectedValue(new Error('db error'));
    const config: OwnCreatedDataAccessConfig = { ...ownConfig, action: 'delete' };
    const ctx = makeContext('u1', 'delete', 'res1');
    const result = await handler.handle(config, ctx);
    expect(result.allowed).toBe(false);
  });
});
