import type {
  Authentication,
  AuthUser,
  Permission,
  Dimension,
  DimensionType,
} from '../interfaces';
import { SimplePermission, DefaultDimensionType } from '../interfaces';

/** Resolve a DimensionType | string to a string ID for comparison */
function dimTypeId(type: string | DimensionType): string {
  return typeof type === 'string' ? type : type.id;
}

/**
 * Default implementation of Authentication.
 * Supports merge() for combining permissions and dimensions from multiple suppliers.
 *
 * Mirrors hsweb SimpleAuthentication.
 */
export class DefaultAuthentication implements Authentication {
  private user: AuthUser;
  private permissions: Permission[];
  private dimensions: Dimension[];
  private attributes: Record<string, unknown>;

  constructor(data?: {
    user?: AuthUser;
    permissions?: Permission[];
    dimensions?: Dimension[];
    attributes?: Record<string, unknown>;
  }) {
    this.user = data?.user || { id: '', username: '' };
    this.permissions = data?.permissions || [];
    this.dimensions = data?.dimensions || [];
    this.attributes = data?.attributes || {};
  }

  getUser(): AuthUser {
    return this.user;
  }

  getPermissions(): Permission[] {
    return this.permissions;
  }

  getDimensions(type?: string | DimensionType): Dimension[] {
    if (!type) return this.dimensions;
    const typeId = dimTypeId(type);
    return this.dimensions.filter((d) => d.type.isSameType(typeId));
  }

  /**
   * 权限检查 — 对齐 hsweb hasPermission(String, Collection<String>)
   *
   * Java reference (Authentication.java):
   *   for (Permission permission : getPermissions()) {
   *     if (Objects.equals(permission.getId(), "*")) return true;   // wildcard = all access
   *     if (Objects.equals(permissionId, permission.getId())) {
   *       return actions.isEmpty() || permission.getActions().containsAll(actions) || permission.getActions().contains("*");
   *     }
   *   }
   *
   * Key: wildcard permission '*' grants ALL access unconditionally (no action check).
   *
   * 并发安全改进（对齐 hsweb 5.x commit ba707cd39）：
   * 在方法入口先捕获 this.permissions 到局部变量，防止在迭代过程中
   * 字段被 merge() 方法并发修改导致 NPE（Java 中）或意外行为。
   */
  hasPermission(permissionId: string, ...actions: string[]): boolean {
    const permissions = this.permissions; // local capture for safety
    for (const permission of permissions) {
      // Wildcard permission grants all access unconditionally
      if (permission.id === '*') {
        return true;
      }
      if (permission.id === permissionId) {
        if (actions.length === 0) return true;
        if (permission.actions.includes('*')) return true;
        return actions.every((a) => permission.actions.includes(a));
      }
    }
    return false;
  }

  /**
   * 维度检查 — 对齐 hsweb 5.x 并发安全模式
   * 先捕获 this.dimensions 到局部变量再操作。
   */
  hasDimension(type: string | DimensionType, ...ids: string[]): boolean {
    const dimensions = this.dimensions; // local capture for safety
    const typeId = dimTypeId(type);
    const matching = dimensions.filter((d) => d.type.isSameType(typeId));
    if (ids.length === 0) return matching.length > 0;
    return ids.some((id) => matching.some((d) => d.id === id));
  }

  getPermission(id: string): Permission | undefined {
    if (!id) return undefined;
    const permissions = this.permissions; // local capture for safety
    return permissions.find((p) => p.id === id);
  }

  /**
   * Get dimension by type and id.
   * When type is a string, uses case-insensitive comparison
   * (mirrors hsweb: `type.equalsIgnoreCase(dimension.getType().getId())`).
   * When type is a DimensionType, uses isSameType
   * (mirrors hsweb: `type.isSameType(dimension.getType())`).
   */
  getDimension(type: string | DimensionType, id: string): Dimension | undefined {
    if (!type) return undefined;
    const dimensions = this.dimensions; // local capture for safety
    if (typeof type === 'string') {
      return dimensions.find(
        (d) => d.id === id && d.type.id.toLowerCase() === type.toLowerCase(),
      );
    }
    return dimensions.find(
      (d) => d.id === id && type.isSameType(d.type),
    );
  }

  getAttributes(): Record<string, unknown> {
    return this.attributes;
  }

  getAttribute<T>(key: string): T | undefined {
    return this.attributes[key] as T | undefined;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: Record<string, unknown>): void {
    this.attributes = attributes;
  }

  /**
   * Set the user. Also adds the user as a dimension of type 'user'
   * (mirrors hsweb SimpleAuthentication.setUser which calls `dimensions.add(user)`).
   *
   * Java hsweb unconditionally appends the user to the dimensions list since
   * User implements Dimension. We replicate this behavior.
   */
  setUser(user: AuthUser): void {
    this.user = user;
    // Add user as a dimension (mirrors hsweb: User extends Dimension, dimensions.add(user))
    if (user.id) {
      const userDim: Dimension = {
        id: user.id,
        name: (user.name as string) || user.username,
        type: DefaultDimensionType.user,
      };
      this.dimensions.push(userDim);
    }
  }

  /**
   * Set user without adding to dimensions list.
   * Mirrors hsweb SimpleAuthentication.setUser0 (protected method).
   */
  setUser0(user: AuthUser): void {
    this.user = user;
  }

  setPermissions(permissions: Permission[]): void {
    this.permissions = permissions;
  }

  /**
   * Add dimensions to the existing list (mirrors hsweb SimpleAuthentication.setDimensions
   * which calls `this.dimensions.addAll(dimensions)`).
   */
  setDimensions(dimensions: Dimension[]): void {
    this.dimensions.push(...dimensions);
  }

  /**
   * Replace all dimensions (for cases where full replacement is needed).
   */
  replaceDimensions(dimensions: Dimension[]): void {
    this.dimensions = dimensions;
  }

  /**
   * Factory method for subclasses to override (mirrors hsweb SimpleAuthentication.newInstance).
   */
  protected newInstance(): DefaultAuthentication {
    return new DefaultAuthentication();
  }

  /**
   * Static factory (mirrors hsweb SimpleAuthentication.of).
   */
  static of(): DefaultAuthentication {
    return new DefaultAuthentication();
  }

  /**
   * Copy with filters (mirrors hsweb SimpleAuthentication.copy).
   */
  copy(
    permissionFilter: (permission: Permission, action: string) => boolean = () => true,
    dimensionFilter: (dimension: Dimension) => boolean = () => true,
  ): DefaultAuthentication {
    // Mirrors hsweb SimpleAuthentication.copy: uses newInstance() for subclass support
    const authentication = this.newInstance();

    authentication.replaceDimensions(
      this.dimensions.filter(dimensionFilter),
    );
    authentication.setPermissions(
      this.permissions
        .map((p) => {
          if (p.copy) {
            return p.copy(
              (action) => permissionFilter(p, action),
              () => true,
            );
          }
          // Fallback for plain objects
          const filteredActions = p.actions.filter((a) => permissionFilter(p, a));
          return new SimplePermission({
            id: p.id,
            name: p.name,
            actions: filteredActions,
            describe: p.describe,
            dataAccesses: [...(p.dataAccesses || [])],
            options: p.options ? { ...p.options } : undefined,
          });
        })
        .filter((p) => p.actions.length > 0),
    );
    // mirrors hsweb: authentication.setUser(user) — uses setUser0 to avoid re-adding to dimensions
    authentication.setUser0(this.user);
    authentication.setAttributes({ ...this.attributes });
    return authentication;
  }

  /**
   * Add a single dimension (mirrors hsweb SimpleAuthentication.addDimension).
   */
  addDimension(dimension: Dimension): void {
    this.dimensions.push(dimension);
  }

  /**
   * Merge another Authentication into this one.
   * Mostly mirrors hsweb SimpleAuthentication.merge:
   * - User: later suppliers override the current user when present
   * - Permissions: merge by ID, combining actions and dataAccesses; when
   *   other permission is new, use permission.copy() (mirrors hsweb: `permissions.add(permission.copy())`)
   * - Dimensions: merge by type+id dedup (hsweb 5.x: (a, b) -> a keeps first)
   * - Attributes: shallow merge (other wins on conflict)
   */
  merge(other: Authentication): DefaultAuthentication {
    const otherUser = other.getUser();
    if (otherUser && otherUser.id) {
      this.user = otherUser;
    }

    // Merge attributes first (mirrors hsweb: attributes.putAll before permission merge)
    const otherAttrs = other.getAttributes();
    for (const [k, v] of Object.entries(otherAttrs)) {
      this.attributes[k] = v;
    }

    // Merge permissions
    const permMap = new Map<string, Permission>();
    for (const p of this.permissions) {
      permMap.set(p.id, p);
    }
    for (const p of other.getPermissions()) {
      const existing = permMap.get(p.id);
      if (existing) {
        // Merge actions (union)
        const actions = [...new Set([...existing.actions, ...p.actions])];
        // Merge data accesses
        const dataAccesses = [
          ...(existing.dataAccesses || []),
          ...(p.dataAccesses || []),
        ];
        permMap.set(
          p.id,
          new SimplePermission({
            id: p.id,
            name: p.name || existing.name,
            actions,
            describe: p.describe || existing.describe,
            dataAccesses,
          }),
        );
      } else {
        // mirrors hsweb: permissions.add(permission.copy())
        permMap.set(p.id, p.copy ? p.copy() : p);
      }
    }
    this.permissions = Array.from(permMap.values());

    // Merge dimensions (dedup by type+id)
    // Mirrors hsweb SimpleAuthentication.merge: getDimension(type,id).isPresent() check
    // Also aligns with hsweb 5.x (a, b) -> a merge function to keep first on duplicate
    for (const d of other.getDimensions()) {
      if (!this.getDimension(d.type.id, d.id)) {
        this.dimensions.push(d);
      }
    }

    return this;
  }
}

/**
 * Create a DefaultAuthentication from a plain JWT user object (backward compat).
 */
export function fromJwtUser(user: Record<string, unknown>): DefaultAuthentication {
  return new DefaultAuthentication({
    user: {
      id: (user.id || user.sub || '') as string,
      username: (user.username || '') as string,
      ...user,
    },
    permissions: [],
    dimensions: [],
    attributes: {},
  });
}
