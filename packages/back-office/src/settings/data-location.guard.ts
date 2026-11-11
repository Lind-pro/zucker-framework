import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { ConnectionSaveAuditHook, ConnectionSettingsService } from './connection-settings.service';

export interface ConnectionSaveGuardContext {
  readonly profileId: string;
  readonly actorId: string;
  /** The request body as received (not yet parsed by the generic connection update parser). */
  readonly body: Readonly<Record<string, unknown>>;
  readonly settings: ConnectionSettingsService;
  /** The settings host's database adapter. */
  readonly database: DatabaseAdapter;
}
export interface ConnectionSaveGuardResult {
  /** Body handed to the generic parser (guard-specific keys removed). */
  readonly body: unknown;
  /** Extra audit row written inside the save's own transaction (see `ConnectionSettingsService.withSaveAudit`). */
  readonly audit?: ConnectionSaveAuditHook;
}
/**
 * Runs on `PUT <path>/connection-settings/<profileId>` after authentication, permission and Origin checks
 * and before the generic update parser. Throw an HTTP exception to refuse the save.
 */
export interface ConnectionSaveGuard {
  readonly profileId: string;
  check(context: ConnectionSaveGuardContext): Promise<ConnectionSaveGuardResult>;
}

/** Error code of the D14 refusal; the fe-admin Connections page asks for confirmation and resends with the flag. */
export const DATA_LOCATION_CHANGE_CODE = 'DATA_LOCATION_CHANGE_UNACKNOWLEDGED';
const ACKNOWLEDGE = 'acknowledgeDataLocationChange';

export interface DataLocationGuardOptions {
  /** Storage profile id (for example `private-files` or a WebDAV profile). */
  readonly profileId: string;
  /** Fields whose change moves where data is stored (provider, endpoint, bucket, base path). */
  readonly locationFields: readonly string[];
  /** Whether stored data exists at the current location (for example a row count of the file tables). Any throw → 503. */
  readonly hasData: (database: DatabaseAdapter) => Promise<boolean>;
  /** Audit row `module` (default `files`) and model (default `operationLogs`). */
  readonly auditModule?: string;
  readonly operationLogsModel?: string;
  /** Route prefix recorded as audit `path` (default `/management/connection-settings`). */
  readonly auditPath?: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * D14 storage-location guard. A save that changes a location field while data exists is refused with 409
 * (`{code: DATA_LOCATION_CHANGE_CODE, changedFields}`) unless the body carries
 * `acknowledgeDataLocationChange: true`; the flag is removed before the generic parser sees the body.
 * The check compares against the revision the body names (`expectedRevision`); a stale body is left to the
 * save's own compare-and-swap. An acknowledged change is audited (`<auditModule>` /
 * `acknowledge-data-location-change`) in the save's transaction. No object is moved.
 */
export function createDataLocationGuard(options: DataLocationGuardOptions): ConnectionSaveGuard {
  if (!options || typeof options.profileId !== 'string' || !Array.isArray(options.locationFields) || !options.locationFields.length || typeof options.hasData !== 'function')
    throw new TypeError('[back-office/settings] data location guard needs profileId, locationFields and hasData');
  const auditModule = options.auditModule ?? 'files', model = options.operationLogsModel ?? 'operationLogs';
  const path = `${options.auditPath ?? '/management/connection-settings'}/${options.profileId}`;
  return Object.freeze({
    profileId: options.profileId,
    async check({ body, settings, database, profileId }: ConnectionSaveGuardContext): Promise<ConnectionSaveGuardResult> {
      const acknowledged = body[ACKNOWLEDGE];
      if (acknowledged !== undefined && typeof acknowledged !== 'boolean') throw new BadRequestException('Invalid connection update');
      const { [ACKNOWLEDGE]: _flag, ...rest } = body;
      const current = await settings.get(profileId);
      const values = rest.values;
      if (rest.expectedRevision !== current.storedRevision || (values !== undefined && !record(values))) return { body: rest };
      const changed = options.locationFields.filter(key => {
        const field = current.fields.find(row => row.key === key);
        if (!field || !values || !Object.hasOwn(values, key)) return false;
        const submitted = values[key];
        if (submitted !== null && typeof submitted !== 'string') return false; // the parser rejects it
        const candidate = submitted === null ? field.defaultValue ?? '' : submitted.trim();
        return candidate !== ((field as { value?: string | null }).value ?? '').trim();
      });
      if (!changed.length) return { body: rest };
      let exists: boolean;
      try { exists = await options.hasData(database); } catch { throw new ServiceUnavailableException('Stored files could not be counted'); }
      if (!exists) return { body: rest };
      if (acknowledged !== true) throw new ConflictException({ code: DATA_LOCATION_CHANGE_CODE, changedFields: changed,
        message: `Changing ${changed.join(', ')} moves where files are stored; existing files are not moved. Resend with ${ACKNOWLEDGE}: true to confirm` });
      return {
        body: rest,
        audit: async (tx, entry) => {
          if (entry.profileId !== profileId) return;
          await tx.model(model).create({ data: { module: auditModule, action: 'acknowledge-data-location-change', status: 'SUCCESS',
            userId: entry.actorId, targetId: profileId, targetType: 'connection-profile', method: 'PUT', path,
            metadata: { revision: entry.revision, changedFields: changed, objectsMoved: false } } });
        },
      };
    },
  });
}
