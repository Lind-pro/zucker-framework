import { Injectable } from '@nestjs/common';

/** Injection token for the tenant store — replace with a persistent implementation via forRoot(). */
export const TENANT_STORE = 'ZUCKER_TENANT_STORE';

/** A single tenant record */
export interface TenantRecord {
  id: string;
  name: string;
  code: string;
  description?: string;
  /** Whether the tenant is enabled */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface CreateTenantRequest {
  name: string;
  code: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface UpdateTenantRequest {
  name?: string;
  code?: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Replaceable tenant store interface — implement to persist records to a database. */
export interface TenantStoreInterface {
  list(filter?: Record<string, unknown>): TenantRecord[];
  findById(id: string): TenantRecord | undefined;
  create(data: CreateTenantRequest): TenantRecord;
  update(id: string, data: UpdateTenantRequest): TenantRecord | undefined;
  delete(id: string): boolean;
}

/**
 * Default in-memory tenant store.
 * Survives only for the process lifetime — suitable for development or small deployments.
 * Swap out via ZuckerTenantAdminModule.forRoot({ store: MyPersistentTenantStore }).
 */
@Injectable()
export class InMemoryTenantStore implements TenantStoreInterface {
  private readonly store = new Map<string, TenantRecord>();
  private idCounter = 0;

  list(filter?: Record<string, unknown>): TenantRecord[] {
    let records = [...this.store.values()];
    if (filter) {
      records = records.filter((r) =>
        Object.entries(filter).every(([key, value]) => r[key] === value),
      );
    }
    return records;
  }

  findById(id: string): TenantRecord | undefined {
    return this.store.get(id);
  }

  create(data: CreateTenantRequest): TenantRecord {
    const id = String(++this.idCounter);
    const now = new Date().toISOString();
    const record: TenantRecord = {
      id,
      name: data.name,
      code: data.code,
      description: data.description,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(id, record);
    return record;
  }

  update(id: string, data: UpdateTenantRequest): TenantRecord | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;
    const updated: TenantRecord = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}
