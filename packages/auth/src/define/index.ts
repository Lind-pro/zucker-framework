/**
 * Authorization definition types — mirrors hsweb-authorization-api define package.
 *
 * ResourceDefinition / ResourceActionDefinition / AuthorizeDefinition
 * describe the permission model that gets scanned from decorators at startup
 * and stored for runtime RBAC checks.
 */

/** Logical operator for combining permission checks */
export type Logical = 'AND' | 'OR' | 'DEFAULT';

/** Phase of authorization check */
export type Phased = 'before' | 'after';

/** Handle type for authorization events */
export type HandleType = 'RBAC' | 'DATA';

// ─── DataAccessTypeDefinition ───────────────────────────────────────

export interface DataAccessTypeDefinition {
  id: string;
  name: string;
  description?: string;
  controller?: string;
  configuration?: Record<string, unknown>;
}

// ─── DataAccessDefinition ───────────────────────────────────────────

export interface DataAccessDefinition {
  dataAccessTypes: Set<DataAccessTypeDefinition>;
}

export function createDataAccessDefinition(): DataAccessDefinition {
  return { dataAccessTypes: new Set() };
}

// ─── ResourceActionDefinition ───────────────────────────────────────

/**
 * Defines a single action within a resource (e.g. query, save, delete).
 * Mirrors hsweb ResourceActionDefinition.
 */
export interface ResourceActionDefinition {
  id: string;
  name: string;
  description?: string;
  dataAccess: DataAccessDefinition;
}

export function createResourceActionDefinition(
  id: string,
  name: string,
  description?: string,
): ResourceActionDefinition {
  return {
    id,
    name,
    description,
    dataAccess: createDataAccessDefinition(),
  };
}

// ─── ResourceDefinition ─────────────────────────────────────────────

/**
 * Defines a permission resource (e.g. "user", "device", "role").
 * Mirrors hsweb ResourceDefinition with actions, logical, phased.
 */
export interface ResourceDefinition {
  id: string;
  name: string;
  description?: string;
  actions: Map<string, ResourceActionDefinition>;
  group?: string[];
  logical: Logical;
  phased: Phased;
}

export function createResourceDefinition(
  id: string,
  name: string,
  options?: {
    description?: string;
    logical?: Logical;
    phased?: Phased;
    group?: string[];
  },
): ResourceDefinition {
  return {
    id,
    name,
    description: options?.description,
    actions: new Map(),
    group: options?.group,
    logical: options?.logical ?? 'DEFAULT',
    phased: options?.phased ?? 'before',
  };
}

/** Add an action to a resource, merging data access types if action already exists */
export function addActionToResource(
  resource: ResourceDefinition,
  action: ResourceActionDefinition,
): void {
  const existing = resource.actions.get(action.id);
  if (existing) {
    // Merge data access types
    for (const dat of action.dataAccess.dataAccessTypes) {
      existing.dataAccess.dataAccessTypes.add(dat);
    }
  } else {
    resource.actions.set(action.id, action);
  }
}

/** Get all action IDs for a resource */
export function getActionIds(resource: ResourceDefinition): Set<string> {
  return new Set(resource.actions.keys());
}

/** Check if a resource has specific actions (respects logical AND/OR) */
export function hasAction(
  resource: ResourceDefinition,
  actions: string[],
): boolean {
  if (resource.actions.size === 0) return true;
  if (actions.length === 0) return false;

  const ids = getActionIds(resource);
  if (resource.logical === 'AND') {
    return actions.every((a) => ids.has(a));
  }
  // OR or DEFAULT
  return actions.some((a) => ids.has(a));
}

/** Get actions that have data access definitions */
export function getDataAccessActions(
  resource: ResourceDefinition,
): ResourceActionDefinition[] {
  return Array.from(resource.actions.values()).filter(
    (act) => act.dataAccess.dataAccessTypes.size > 0,
  );
}

// ─── DimensionDefinition ────────────────────────────────────────────

export interface DimensionDefinition {
  typeId: string;
  dimensionIds: Set<string>;
  logical: Logical;
}

// ─── AuthorizeDefinition ────────────────────────────────────────────

/**
 * Complete authorization definition for a controller method.
 * Mirrors hsweb AuthorizeDefinition.
 */
export interface AuthorizeDefinition {
  resources: ResourceDefinition[];
  dimensions: DimensionDefinition[];
  message: string;
  phased: Phased;
  isEmpty: boolean;
}

export function createEmptyAuthorizeDefinition(): AuthorizeDefinition {
  return {
    resources: [],
    dimensions: [],
    message: 'error.access_denied',
    phased: 'before',
    isEmpty: true,
  };
}

/** Get human-readable description of the definition (e.g. "user:query,save") */
export function getDefinitionDescription(def: AuthorizeDefinition): string {
  return def.resources
    .map((r) => `${r.id}:${Array.from(getActionIds(r)).join(',')}`)
    .join(';');
}

/**
 * Check if an authentication has permission matching the resource definitions.
 * Mirrors hsweb ResourcesDefinition.hasPermission().
 */
export function hasPermissionForResources(
  resources: ResourceDefinition[],
  hasPermissionFn: (resourceId: string, actions: string[]) => boolean,
): boolean {
  if (resources.length === 0) return true;
  return resources.every((resource) => {
    const actions = Array.from(getActionIds(resource));
    return hasPermissionFn(resource.id, actions);
  });
}
