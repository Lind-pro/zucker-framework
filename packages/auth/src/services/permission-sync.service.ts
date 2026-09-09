import { Injectable, Inject, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { PermissionScannerService, type ScannedPermission } from './permission-scanner.service';

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

/**
 * PermissionSyncService
 *
 * Scans controller decorators (@Resource/@Action) at startup and synchronizes
 * discovered permission definitions to the database. Existing permissions are
 * updated (actions merged), new permissions are created.
 *
 * Key behaviors:
 * - Scan @Resource/@Action definitions with PermissionScannerService
 * - Merge with existing DB records (preserve custom actions, merge new ones)
 * - Convert ResourceDefinition to PermissionEntity with actions and optionalFields
 * - Upsert (save) all merged permissions to the database
 */
@Injectable()
export class PermissionSyncService implements OnModuleInit {
  private readonly logger = new Logger(PermissionSyncService.name);
  private enabled = true;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() private readonly scannerService?: PermissionScannerService,
  ) {}

  /** Disable automatic sync on startup (useful for tests) */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * NestJS lifecycle hook -- runs permission synchronization on startup.
   */
  async onModuleInit(): Promise<void> {
    if (!this.enabled || !this.scannerService) {
      return;
    }

    try {
      await this.synchronize();
    } catch (err) {
      this.logger.warn(`Permission sync error: ${err}`);
    }
  }

  /**
   * Perform permission synchronization.
   *
   * 1. Scan all controller @Resource/@Action decorators
   * 2. Load existing permissions from database
   * 3. Merge scanned definitions with existing records
   * 4. Upsert merged permissions back to database
   */
  async synchronize(): Promise<{ total: number; created: number; updated: number }> {
    const scanned = this.scannerService!.scanPermissions();

    if (scanned.length === 0) {
      return { total: 0, created: 0, updated: 0 };
    }

    // Load existing permissions
    const existingList = (await this.db.model('permissions').findMany({})) as Array<{
      id: string;
      name: string;
      description?: string;
      status?: boolean;
      actions?: unknown;
      optionalFields?: unknown;
    }>;

    const existingMap = new Map<string, (typeof existingList)[0]>();
    for (const p of existingList) {
      existingMap.set(p.id, p);
    }

    let created = 0;
    let updated = 0;

    for (const permission of scanned) {
      const merged = this.mergePermission(existingMap.get(permission.id), permission);

      try {
        if (existingMap.has(permission.id)) {
          await this.db.model('permissions').update({
            where: { id: permission.id },
            data: merged,
          });
          updated++;
        } else {
          await this.db.model('permissions').create({
            data: { id: permission.id, ...merged },
          });
          created++;
        }
      } catch (err) {
        this.logger.warn(`Failed to sync permission ${permission.id}: ${err}`);
      }
    }

    this.logger.log(
      `Permission sync complete: ${scanned.length} total, ${created} created, ${updated} updated`,
    );

    return { total: scanned.length, created, updated };
  }

  /**
   * Merge a scanned permission definition with an existing database record.
   *
   * - Preserves existing name/description if already set
   * - Merges actions (new actions added, existing preserved)
   * - Preserves existing optionalFields
   * - Adds supportDataAccessTypes from scanned definition
   */
  private mergePermission(
    existing: { id: string; name: string; description?: string; status?: boolean; actions?: unknown; optionalFields?: unknown } | undefined,
    scanned: ScannedPermission,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (existing) {
      // Preserve existing name, but update if empty
      result.name = existing.name || scanned.name;
      result.description = existing.description || scanned.description;
      result.status = existing.status ?? scanned.status;

      // Merge actions
      const existingActions = this.parseActions(existing.actions);
      const existingActionMap = new Map<string, Record<string, unknown>>();
      for (const action of existingActions) {
        existingActionMap.set(action.action as string, action);
      }

      for (const scannedAction of scanned.actions) {
        const existingAction = existingActionMap.get(scannedAction.action);
        if (existingAction) {
          // Merge supportDataAccessTypes
          const existingProps = (existingAction.properties ?? {}) as Record<string, unknown>;
          const existingTypes = new Set<string>(
            Array.isArray(existingProps.supportDataAccessTypes)
              ? (existingProps.supportDataAccessTypes as string[])
              : [],
          );
          const scannedTypes = scannedAction.properties?.supportDataAccessTypes;
          if (Array.isArray(scannedTypes)) {
            for (const t of scannedTypes) {
              existingTypes.add(t as string);
            }
          }
          existingAction.properties = {
            ...existingProps,
            supportDataAccessTypes: Array.from(existingTypes),
          };
        } else {
          existingActionMap.set(scannedAction.action, {
            action: scannedAction.action,
            name: scannedAction.name,
            describe: scannedAction.description,
            properties: scannedAction.properties ?? { supportDataAccessTypes: [] },
          });
        }
      }

      result.actions = JSON.parse(JSON.stringify(Array.from(existingActionMap.values())));

      // Preserve optionalFields if already populated
      if (existing.optionalFields && Array.isArray(existing.optionalFields) && (existing.optionalFields as unknown[]).length > 0) {
        result.optionalFields = existing.optionalFields;
      } else if (scanned.optionalFields && scanned.optionalFields.length > 0) {
        result.optionalFields = JSON.parse(JSON.stringify(scanned.optionalFields));
      }
    } else {
      // New permission
      result.name = scanned.name;
      result.description = scanned.description;
      result.status = scanned.status;
      result.actions = JSON.parse(
        JSON.stringify(
          scanned.actions.map((a) => ({
            action: a.action,
            name: a.name,
            describe: a.description,
            properties: a.properties ?? { supportDataAccessTypes: [] },
          })),
        ),
      );
      if (scanned.optionalFields && scanned.optionalFields.length > 0) {
        result.optionalFields = JSON.parse(JSON.stringify(scanned.optionalFields));
      }
    }

    return result;
  }

  private parseActions(actions: unknown): Array<Record<string, unknown>> {
    if (!actions) return [];
    if (Array.isArray(actions)) return actions as Array<Record<string, unknown>>;
    try {
      const parsed = typeof actions === 'string' ? JSON.parse(actions) : actions;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
