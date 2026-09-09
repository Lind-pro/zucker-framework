/**
 * Data access control configuration types.
 */

/** Data access control type identifier */
export interface DataAccessType {
  id: string;
  name: string;
}

/** Built-in data access types */
export const DefaultDataAccessType = {
  OWN_CREATED: { id: 'OWN_CREATED', name: '仅限自己创建的数据' } as DataAccessType,
  DENY_FIELDS: { id: 'DENY_FIELDS', name: '字段级权限控制' } as DataAccessType,
  SCOPE: { id: 'SCOPE', name: '范围数据权限' } as DataAccessType,
  DIMENSION_SCOPE: { id: 'DIMENSION_SCOPE', name: '维度范围数据权限' } as DataAccessType,
} as const;

/**
 * Base data access configuration.
 * Each config binds to a specific action (query/update/delete/etc.)
 * and a specific type of access control.
 */
export interface DataAccessConfig {
  /** The action this config applies to (e.g. 'query', 'update', 'delete') */
  action: string;
  /** Access control type */
  type: DataAccessType;
}

/**
 * Only allow access to records created by the current user.
 * The creator field name is configurable (defaults to 'creatorId').
 */
export interface OwnCreatedDataAccessConfig extends DataAccessConfig {
  type: typeof DefaultDataAccessType.OWN_CREATED;
  /** The field that stores the creator user ID (default: 'creatorId') */
  creatorField?: string;
}

/**
 * Field-level access control: deny access to specific fields.
 */
export interface FieldFilterDataAccessConfig extends DataAccessConfig {
  type: typeof DefaultDataAccessType.DENY_FIELDS;
  /** Fields that should be denied/filtered */
  fields: string[];
}

/**
 * Scope-based row-level access control.
 * Injects WHERE conditions based on scope type and values.
 */
export interface ScopeDataAccessConfig extends DataAccessConfig {
  type: typeof DefaultDataAccessType.SCOPE;
  /** Scope type identifier (e.g. 'org', 'department') */
  scopeType: string;
  /** Scope values to filter by */
  scope: unknown[];
}

/**
 * Dimension-based row-level access control.
 * Uses the dimension system to filter rows based on user's dimension membership.
 */
export interface DimensionDataAccessConfig extends DataAccessConfig {
  type: typeof DefaultDataAccessType.DIMENSION_SCOPE;
  /** Dimension type / scopeType  */
  dimensionType: string;
  /** The field on the resource that holds the dimension value */
  dimensionField?: string;
  /** Whether to include child dimensions in scope  */
  children?: boolean;
}

/** Helper to create OwnCreated config */
export function ownCreatedConfig(
  action: string,
  creatorField?: string,
): OwnCreatedDataAccessConfig {
  return {
    action,
    type: DefaultDataAccessType.OWN_CREATED,
    creatorField,
  };
}

/** Helper to create FieldFilter config */
export function fieldFilterConfig(
  action: string,
  fields: string[],
): FieldFilterDataAccessConfig {
  return {
    action,
    type: DefaultDataAccessType.DENY_FIELDS,
    fields,
  };
}

/** Helper to create Scope config */
export function scopeConfig(
  action: string,
  scopeType: string,
  scope: unknown[],
): ScopeDataAccessConfig {
  return {
    action,
    type: DefaultDataAccessType.SCOPE,
    scopeType,
    scope,
  };
}

/** Helper to create Dimension config */
export function dimensionConfig(
  action: string,
  dimensionType: string,
  dimensionField?: string,
): DimensionDataAccessConfig {
  return {
    action,
    type: DefaultDataAccessType.DIMENSION_SCOPE,
    dimensionType,
    dimensionField,
  };
}
