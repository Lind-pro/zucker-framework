import type { DatabaseAdapter } from '@zucker-framework/core';
import { BcryptEncoder, UsernameValidator, UserService, type PasswordEncoder } from '@zucker-framework/auth';
import { DEFAULT_ACCOUNTS_MODELS, type AccountModelKey } from './accounts.options';
import { resolveModelNames } from '../shared/models';

type Models = Partial<Record<AccountModelKey, string>>;
const models = (overrides?: Models) => resolveModelNames('accounts', DEFAULT_ACCOUNTS_MODELS, overrides);

/** One back-office navigation entry; `parent` refers to another entry's `key`. */
export interface MenuCatalogEntry { key: string; name: string; path?: string; parent?: string; permission?: string; icon?: string }
export interface MenuSyncOptions {
  /** Stable id prefix of catalog rows (`<prefix><key>`), e.g. `starter:` or a product prefix. */
  idPrefix?: string;
  /** Also bring existing catalog rows back to the catalog (default false: operator edits survive). */
  overwrite?: boolean;
  models?: Models;
}
/** Outcome of an idempotent sync: rows written only when something differs. */
export interface SyncResult { created: number; updated: number; unchanged: number }

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Fields of `desired` that differ from `row` (only those are written). */
function changes(row: Record<string, unknown>, desired: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(desired).filter(([key, value]) => !sameValue(row[key], value)));
}

/**
 * Creates the catalog's missing menu rows (id `<prefix><key>`, sort order = catalog position). Existing
 * rows are left alone unless `overwrite` is set, and then written only when a field differs, so it can
 * run on every deploy without writes. Run in the caller's transaction.
 */
export async function syncMenus(db: DatabaseAdapter, catalog: readonly MenuCatalogEntry[], options: MenuSyncOptions = {}): Promise<SyncResult> {
  const prefix = options.idPrefix ?? 'starter:';
  if (!/^[a-z][a-z0-9-]{0,31}:$/.test(prefix)) throw new TypeError('[back-office/accounts] menu idPrefix must look like "name:"');
  const keys = new Set(catalog.map(entry => entry.key));
  for (const entry of catalog) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.key) || (entry.parent && !keys.has(entry.parent))) throw new TypeError(`[back-office/accounts] invalid menu entry "${entry.key}"`);
  }
  const menus = db.model(models(options.models).menus);
  const result: SyncResult = { created: 0, updated: 0, unchanged: 0 };
  for (const [sortOrder, entry] of catalog.entries()) {
    const id = `${prefix}${entry.key}`;
    const desired = { name: entry.name, ...(entry.path ? { path: entry.path } : {}), ...(entry.icon ? { icon: entry.icon } : {}),
      ...(entry.parent ? { parentId: `${prefix}${entry.parent}` } : {}), permissions: entry.permission ? [entry.permission] : [], sortOrder };
    const row = await menus.findUnique({ where: { id } }) as Record<string, unknown> | null;
    if (!row) { await menus.create({ data: { id, ...desired, status: true } }); result.created++; continue; }
    const diff = options.overwrite ? changes(row, desired) : {};
    if (Object.keys(diff).length) { await menus.update({ where: { id }, data: diff }); result.updated++; }
    else result.unchanged++;
  }
  return result;
}

/** A permission code, or a code with its display name/description. */
export type PermissionCatalogEntry = string | { code: string; name?: string; description?: string };

/**
 * Creates missing permission rows (`id = code`) and, for entries that carry a `name`/`description`,
 * updates only the fields that differ. Nothing is written when the table already matches, so it can run
 * on every deploy; the counts report what happened.
 */
export async function syncPermissions(db: DatabaseAdapter, entries: Iterable<PermissionCatalogEntry>,
  options: { description?: string; models?: Models } = {}): Promise<SyncResult> {
  const permissions = db.model(models(options.models).permissions);
  const catalog = new Map<string, { code: string; name?: string; description?: string }>();
  for (const entry of entries) {
    const item = typeof entry === 'string' ? { code: entry } : entry;
    if (!item || typeof item.code !== 'string' || !/^[A-Za-z0-9_.:*-]{1,191}$/.test(item.code)) throw new TypeError(`[back-office/accounts] invalid permission code "${String(item?.code)}"`);
    catalog.set(item.code, { ...catalog.get(item.code), ...item });
  }
  const result: SyncResult = { created: 0, updated: 0, unchanged: 0 };
  for (const item of catalog.values()) {
    const row = await permissions.findUnique({ where: { id: item.code } }) as Record<string, unknown> | null;
    if (!row) {
      await permissions.create({ data: { id: item.code, name: item.name ?? item.code, description: item.description ?? options.description ?? 'Seeded with the back office' } });
      result.created++; continue;
    }
    const diff = changes(row, { ...(item.name !== undefined ? { name: item.name } : {}), ...(item.description !== undefined ? { description: item.description } : {}) });
    if (Object.keys(diff).length) { await permissions.update({ where: { id: item.code }, data: diff }); result.updated++; }
    else result.unchanged++;
  }
  return result;
}

/**
 * Starter data contributed by features (plans, CMS pages, …). Each seed runs in the administrator-setup
 * transaction and must be idempotent: create only what is missing, never change edited rows.
 */
export interface StarterDataSeed {
  /** Short stable name, used only in error messages. */
  readonly name: string;
  run(tx: DatabaseAdapter): Promise<void>;
}
/** Runs the seeds in order on the caller's transaction. A failing seed aborts the whole setup. */
export async function seedStarterData(tx: DatabaseAdapter, seeds: readonly StarterDataSeed[]): Promise<void> {
  for (const seed of seeds) {
    try { await seed.run(tx); }
    catch (error) { throw new Error(`Starter data seed ${seed.name} failed`, { cause: error }); }
  }
}

export interface CreateAdministratorOptions {
  menus?: readonly MenuCatalogEntry[];
  menuIdPrefix?: string;
  /** Permission codes checked with `@Permissions(code)` that must exist as rows (menu codes are added). */
  permissions?: readonly string[];
  seeds?: readonly StarterDataSeed[];
  passwordEncoder?: PasswordEncoder;
  /** `users.typeId` of the owner account (default `administrator`). */
  typeId?: string;
  models?: Models;
}

/**
 * Explicit owner setup (a CLI, never an HTTP route): creates a new verified account with the
 * `superadmin` role (creating the role when missing), the menu catalog, permission rows and starter
 * data in one transaction. An existing username is refused; accounts are never promoted or overwritten.
 */
export async function createAdministrator(db: DatabaseAdapter, input: { username: string; email: string; password: string },
  options: CreateAdministratorOptions = {}): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid administrator email');
  const names = models(options.models);
  return db.$transaction(async tx => {
    const users = new UserService(tx, options.passwordEncoder ?? new BcryptEncoder());
    // Reserved public account names may be used only by this explicit owner command.
    users.setUsernameValidator(new UsernameValidator({ reservedNames: [] }));
    if (await users.findByUsername(input.username)) throw new Error('Account already exists; existing accounts are never promoted or overwritten');
    const user = await users.addUser({ username: input.username, password: input.password, email, name: input.username,
      typeId: options.typeId ?? 'administrator', status: true, emailVerified: true });
    const roles = tx.model(names.roles);
    const role = ((await roles.findUnique({ where: { name: 'superadmin' } })) ??
      (await roles.create({ data: { name: 'superadmin', description: 'Administrator' } }))) as { id: string };
    await tx.model(names.userRoles).create({ data: { userId: user.id, roleId: role.id } });
    const menus = options.menus ?? [];
    await syncMenus(tx, menus, { idPrefix: options.menuIdPrefix, models: options.models });
    await syncPermissions(tx, [...(options.permissions ?? []), ...menus.flatMap(menu => menu.permission ? [menu.permission] : [])],
      { description: 'Seeded with the starter back office', models: options.models });
    await seedStarterData(tx, options.seeds ?? []);
    return user.id;
  });
}

export class AssignRoleError extends Error {}
export interface AssignRoleResult {
  userId: string; roleId: string; roleName: string; assigned: boolean;
  /** End of the assignment (null = never expires). */
  expiresAt: Date | null;
  /** An existing assignment whose expiry was changed by `expires`. */
  expiryUpdated?: boolean;
}
export interface AssignRoleInput { email: string; role: string; expires?: string }

const DAY_MS = 86_400_000;
/** `expires` value: an ISO 8601 date/time in the future, or `<N>d` (1–3650 days from `now`). */
export function parseRoleExpiry(value: string, now = new Date()): Date {
  const trimmed = value.trim();
  const days = /^(\d{1,4})d$/i.exec(trimmed);
  if (days) {
    const count = Number(days[1]);
    if (count < 1 || count > 3650) throw new AssignRoleError('--expires days must be between 1 and 3650');
    return new Date(now.getTime() + count * DAY_MS);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    throw new AssignRoleError('--expires must be an ISO date (2026-12-31 or 2026-12-31T12:00:00Z) or a number of days (30d)');
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) throw new AssignRoleError('--expires is not a valid date');
  if (date.getTime() <= now.getTime()) throw new AssignRoleError('--expires must be in the future');
  return date;
}

/**
 * Explicit owner command: grants an existing, enabled role (by name or id) to an existing account found
 * by e-mail, optionally until `expires` (role links with a past `expiresAt` grant nothing). Unknown
 * accounts and roles are refused (roles are never created here); an existing assignment is kept
 * (`assigned: false`) unless `expires` changes its end. Each change is audited in `operationLogs`.
 */
export async function assignRoleByEmail(db: DatabaseAdapter, input: AssignRoleInput, now = new Date(), options: { models?: Models } = {}): Promise<AssignRoleResult> {
  const email = input.email.trim().toLowerCase(), role = input.role.trim();
  const expiresAt = input.expires === undefined ? null : parseRoleExpiry(input.expires, now);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AssignRoleError('Invalid email');
  if (!role || role.length > 191 || /[\u0000-\u001f\u007f]/.test(role)) throw new AssignRoleError('Invalid role');
  const names = models(options.models);
  return db.$transaction(async tx => {
    const user = await tx.model(names.users).findUnique({ where: { email }, select: { id: true } }) as { id: string } | null;
    if (!user) throw new AssignRoleError('No account uses this email');
    const roles = tx.model(names.roles), links = tx.model(names.userRoles);
    const found = (await roles.findUnique({ where: { name: role }, select: { id: true, name: true, status: true } })
      ?? await roles.findUnique({ where: { id: role }, select: { id: true, name: true, status: true } })) as
      { id: string; name: string; status: boolean | null } | null;
    if (!found) throw new AssignRoleError('Unknown role; create it in the back office first');
    if (found.status === false) throw new AssignRoleError('Role is disabled');
    const existing = await links.findUnique({ where: { userId_roleId: { userId: user.id, roleId: found.id } } }) as
      { id: string; expiresAt: Date | null } | null;
    const audit = (action: string) => tx.model(names.operationLogs).create({ data: { module: 'accounts', action, status: 'SUCCESS',
      targetId: user.id, targetType: 'account', metadata: { roleId: found.id, roleName: found.name, via: 'cli',
        expiresAt: expiresAt ? expiresAt.toISOString() : null } } });
    if (existing) {
      // Without expires an existing assignment is left as it is; with it, the explicit end replaces the old one.
      if (!expiresAt || existing.expiresAt?.getTime() === expiresAt.getTime()) {
        return { userId: user.id, roleId: found.id, roleName: found.name, assigned: false, expiresAt: existing.expiresAt ?? null };
      }
      await links.update({ where: { id: existing.id }, data: { expiresAt } });
      await audit('assign-role-expiry');
      return { userId: user.id, roleId: found.id, roleName: found.name, assigned: false, expiresAt, expiryUpdated: true };
    }
    await links.create({ data: { userId: user.id, roleId: found.id, expiresAt } });
    await audit('assign-role');
    return { userId: user.id, roleId: found.id, roleName: found.name, assigned: true, expiresAt };
  });
}
/** Alias of `assignRoleByEmail` (bootstrap naming). */
export const assignRole = assignRoleByEmail;

/** Parses `--email <value> --role <value> [--expires <ISO date | Nd>]` (also `--name=<value>`); anything else is refused. */
export function parseAssignRoleArguments(argv: readonly string[], usage = 'Usage: --email <address> --role <name-or-id> [--expires <ISO date | Nd>]'): AssignRoleInput {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') continue;
    const match = /^--(email|role|expires)(?:=(.*))?$/.exec(argument);
    if (!match) throw new AssignRoleError(`Unknown argument ${argument.slice(0, 40)}`);
    const value = match[2] ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new AssignRoleError(`Missing value for --${match[1]}`);
    if (Object.hasOwn(values, match[1]!)) throw new AssignRoleError(`Duplicate --${match[1]}`);
    values[match[1]!] = value;
  }
  if (!values.email || !values.role) throw new AssignRoleError(usage);
  if (values.expires !== undefined) parseRoleExpiry(values.expires);
  return { email: values.email, role: values.role, ...(values.expires !== undefined ? { expires: values.expires } : {}) };
}
