import { describe, it, expect } from 'vitest';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  RESOURCE_KEY,
  ACTION_KEY,
  AUTHORIZE_KEY,
  DATA_PERMISSION_KEY,
  TWO_FACTOR_KEY,
  DIMENSION_KEY,
} from './constants';
import {
  Public,
  Permissions,
  RequirePermissions,
  Resource,
  Action,
  QueryAction,
  CreateAction,
  SaveAction,
  DeleteAction,
  UpdateAction,
  DataPermission,
  SkipDataPermission,
  TwoFactor,
  Authorize,
  DimensionCheck,
  RequiresRoles,
} from './index';

const { Reflect } = globalThis;

// Helper to read metadata from a decorated method
function getMethodMeta(key: string, target: object, method: string) {
  return Reflect.getMetadata(key, (target as any)[method]);
}

describe('Auth Decorators — metadata reading', () => {
  it('@Public sets IS_PUBLIC_KEY to true', () => {
    class C {
      @Public()
      method() {}
    }
    expect(getMethodMeta(IS_PUBLIC_KEY, C.prototype, 'method')).toBe(true);
  });

  it('@Permissions sets PERMISSIONS_KEY', () => {
    class C {
      @Permissions('user:read', 'user:write')
      method() {}
    }
    expect(getMethodMeta(PERMISSIONS_KEY, C.prototype, 'method')).toEqual([
      'user:read',
      'user:write',
    ]);
  });

  it('@RequirePermissions is an alias for @Permissions', () => {
    class C {
      @RequirePermissions('admin')
      method() {}
    }
    expect(getMethodMeta(PERMISSIONS_KEY, C.prototype, 'method')).toEqual([
      'admin',
    ]);
  });

  it('@Resource sets RESOURCE_KEY with options', () => {
    class C {
      @Resource({ id: 'user', name: 'User Management' })
      method() {}
    }
    const meta = getMethodMeta(RESOURCE_KEY, C.prototype, 'method');
    expect(meta).toEqual({ id: 'user', name: 'User Management' });
  });

  it('@Action sets ACTION_KEY', () => {
    class C {
      @Action({ action: 'query', name: 'Query' })
      method() {}
    }
    const meta = getMethodMeta(ACTION_KEY, C.prototype, 'method');
    expect(meta).toEqual({ action: 'query', name: 'Query' });
  });

  it('@QueryAction sets action to "query"', () => {
    class C {
      @QueryAction()
      method() {}
    }
    const meta = getMethodMeta(ACTION_KEY, C.prototype, 'method');
    expect(meta.action).toBe('query');
  });

  it('@CreateAction, @SaveAction, @DeleteAction, @UpdateAction set correct actions', () => {
    class C {
      @CreateAction()
      create() {}
      @SaveAction()
      save() {}
      @DeleteAction()
      del() {}
      @UpdateAction()
      upd() {}
    }
    expect(getMethodMeta(ACTION_KEY, C.prototype, 'create').action).toBe('add');
    expect(getMethodMeta(ACTION_KEY, C.prototype, 'save').action).toBe('save');
    expect(getMethodMeta(ACTION_KEY, C.prototype, 'del').action).toBe('delete');
    expect(getMethodMeta(ACTION_KEY, C.prototype, 'upd').action).toBe('update');
  });

  it('@DataPermission with string sets dataType', () => {
    class C {
      @DataPermission('user')
      method() {}
    }
    expect(getMethodMeta(DATA_PERMISSION_KEY, C.prototype, 'method')).toEqual({
      dataType: 'user',
    });
  });

  it('@SkipDataPermission sets skipDataPermission', () => {
    class C {
      @SkipDataPermission()
      method() {}
    }
    expect(
      getMethodMeta(DATA_PERMISSION_KEY, C.prototype, 'method'),
    ).toEqual({ skipDataPermission: true });
  });

  it('@TwoFactor with string sets operation and defaults', () => {
    class C {
      @(TwoFactor('deleteAccount') as MethodDecorator)
      method() {}
    }
    const meta = getMethodMeta(TWO_FACTOR_KEY, C.prototype, 'method');
    expect(meta.operation).toBe('deleteAccount');
    expect(meta.provider).toBe('default');
    expect(meta.parameter).toBe('verifyCode');
    expect(meta.timeout).toBe(600000);
  });

  it('@TwoFactor with options overrides defaults', () => {
    class C {
      @(TwoFactor({ operation: 'transfer', provider: 'totp', timeout: 30000 }) as MethodDecorator)
      method() {}
    }
    const meta = getMethodMeta(TWO_FACTOR_KEY, C.prototype, 'method');
    expect(meta.provider).toBe('totp');
    expect(meta.timeout).toBe(30000);
  });

  it('@Authorize with ignore sets IS_PUBLIC_KEY', () => {
    class C {
      @(Authorize({ ignore: true }) as MethodDecorator)
      method() {}
    }
    expect(getMethodMeta(IS_PUBLIC_KEY, C.prototype, 'method')).toBe(true);
  });

  it('@Authorize with permissions sets PERMISSIONS_KEY', () => {
    class C {
      @(Authorize({ permissions: ['admin:manage'] }) as MethodDecorator)
      method() {}
    }
    expect(getMethodMeta(PERMISSIONS_KEY, C.prototype, 'method')).toEqual([
      'admin:manage',
    ]);
  });

  it('@Authorize stores curd resources, dimensions, message and merge metadata', () => {
    class C {
      @(Authorize({
        resources: [{
          id: 'user',
          name: '用户',
          actions: [{ action: 'query', name: '查询' }],
          merge: false,
        }],
        dimension: [{ type: 'role', ids: ['admin'], logical: 'AND' }],
        logical: 'AND',
        merge: false,
        message: 'no access',
      }) as MethodDecorator)
      method() {}
    }

    expect(getMethodMeta(AUTHORIZE_KEY, C.prototype, 'method')).toEqual({
      resources: [{
        id: 'user',
        name: '用户',
        actions: [{ action: 'query', name: '查询', description: undefined }],
        description: undefined,
        merge: false,
        logical: 'DEFAULT',
        optionalFields: undefined,
        phased: 'before',
        group: undefined,
      }],
      dimensions: [{ type: 'role', ids: ['admin'], logical: 'AND' }],
      permissions: undefined,
      dataPermission: undefined,
      ignore: false,
      message: 'no access',
      merge: false,
      logical: 'AND',
      phased: 'before',
      description: [],
    });
  });

  it('@DimensionCheck sets DIMENSION_KEY', () => {
    class C {
      @(DimensionCheck({ type: 'department', ids: ['d1'], logical: 'AND' }) as MethodDecorator)
      method() {}
    }
    expect(getMethodMeta(DIMENSION_KEY, C.prototype, 'method')).toEqual({
      type: 'department',
      ids: ['d1'],
      logical: 'AND',
    });
  });

  it('@RequiresRoles defaults to role type and DEFAULT logic', () => {
    class C {
      @(RequiresRoles('admin', 'editor') as MethodDecorator)
      method() {}
    }
    const meta = getMethodMeta(DIMENSION_KEY, C.prototype, 'method');
    expect(meta.type).toBe('role');
    expect(meta.ids).toEqual(['admin', 'editor']);
    expect(meta.logical).toBe('DEFAULT');
  });

  it('@RequiresRoles allows overriding logical mode', () => {
    class C {
      @(RequiresRoles({ logical: 'AND' }, 'admin', 'editor') as MethodDecorator)
      method() {}
    }
    const meta = getMethodMeta(DIMENSION_KEY, C.prototype, 'method');
    expect(meta.logical).toBe('AND');
  });
});
