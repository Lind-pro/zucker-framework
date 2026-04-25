import { Injectable } from '@nestjs/common';

/** Injection token for the i18n store — replace with a persistent implementation via forRoot(). */
export const I18N_STORE = 'ZUCKER_I18N_STORE';

/** A single i18n entry */
export interface I18nEntry {
  id: string;
  /** Message code / key, e.g. "user.notFound" */
  code: string;
  /** Translation map: locale → text, e.g. { zh: "用户不存在", en: "User not found" } */
  translations: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateI18nEntryRequest {
  code: string;
  translations: Record<string, string>;
}

export interface UpdateI18nEntryRequest {
  code?: string;
  translations?: Record<string, string>;
}

/** Replaceable i18n store interface — implement to persist entries to a database. */
export interface I18nStoreInterface {
  list(filter?: { code?: string; locale?: string }): I18nEntry[];
  findById(id: string): I18nEntry | undefined;
  create(data: CreateI18nEntryRequest): I18nEntry;
  update(id: string, data: UpdateI18nEntryRequest): I18nEntry | undefined;
}

/**
 * Default in-memory i18n store.
 * Survives only for the process lifetime — suitable for development or small deployments.
 * Swap out via ZuckerI18nAdminModule.forRoot({ store: MyPersistentI18nStore }).
 */
@Injectable()
export class InMemoryI18nStore implements I18nStoreInterface {
  private readonly store = new Map<string, I18nEntry>();
  private idCounter = 0;

  list(filter?: { code?: string; locale?: string }): I18nEntry[] {
    let entries = [...this.store.values()];
    if (filter?.code) {
      const search = filter.code.toLowerCase();
      entries = entries.filter((e) => e.code.toLowerCase().includes(search));
    }
    if (filter?.locale) {
      entries = entries.filter((e) => filter.locale! in e.translations);
    }
    return entries;
  }

  findById(id: string): I18nEntry | undefined {
    return this.store.get(id);
  }

  create(data: CreateI18nEntryRequest): I18nEntry {
    const id = String(++this.idCounter);
    const now = new Date().toISOString();
    const entry: I18nEntry = {
      id,
      code: data.code,
      translations: { ...data.translations },
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(id, entry);
    return entry;
  }

  update(id: string, data: UpdateI18nEntryRequest): I18nEntry | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;
    const updated: I18nEntry = {
      ...existing,
      code: data.code ?? existing.code,
      translations: data.translations
        ? { ...existing.translations, ...data.translations }
        : existing.translations,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }
}
