import type { EnumDictItem } from './enum-dict';
import { EnumDictRegistry } from './enum-dict';
import { ClearDictionaryCacheEvent } from './clear-dictionary-cache-event';

/**
 * DictDefine — dictionary definition interface.
 *
 * Reference: hsweb-framework DictDefine
 *
 * Represents the metadata and items for a dictionary.
 */
export interface DictDefine {
  /** Unique dictionary ID */
  id: string;
  /** Human-readable alias / display name */
  alias: string;
  /** Description / comments */
  comments: string;
  /** Dictionary items */
  items: EnumDictItem[];
}

/**
 * ClassDictDefine — dictionary definition tied to a class field.
 *
 * Reference: hsweb-framework ClassDictDefine
 *
 * Extends DictDefine with a field binding.
 */
export interface ClassDictDefine extends DictDefine {
  /** The entity field this dictionary is bound to */
  field: string;
}

/**
 * ItemDefine — standalone dictionary item definition.
 *
 * Reference: hsweb-framework ItemDefine / DefaultItemDefine
 */
export interface ItemDefine {
  value: string;
  text: string;
  comments: string;
  ordinal: number;
}

/**
 * Create a DictDefine from raw data.
 *
 * Reference: hsweb-framework DefaultDictDefine
 */
export function createDictDefine(
  id: string,
  alias: string,
  comments: string,
  items: EnumDictItem[],
): DictDefine {
  return { id, alias, comments, items };
}

/**
 * Create a ClassDictDefine from raw data.
 *
 * Reference: hsweb-framework DefaultClassDictDefine
 */
export function createClassDictDefine(
  id: string,
  field: string,
  alias: string,
  comments: string,
  items: EnumDictItem[],
): ClassDictDefine {
  return { id, field, alias, comments, items };
}

/**
 * DictDefineRepository — stores and retrieves dictionary definitions.
 *
 * Reference: hsweb-framework DictDefineRepository / DefaultDictDefineRepository
 *
 * In hsweb this is reactive (Mono/Flux); here we use sync + async patterns
 * suitable for NestJS.
 */
export class DictDefineRepository {
  private readonly defines = new Map<string, DictDefine>();

  /**
   * Register a dictionary definition.
   */
  addDefine(define: DictDefine): void {
    this.defines.set(define.id, define);
  }

  /**
   * Get a dictionary definition by ID.
   */
  getDefine(id: string): DictDefine | undefined {
    // First check local defines, then fall back to EnumDictRegistry
    const local = this.defines.get(id);
    if (local) return local;

    // Auto-create from EnumDictRegistry if available
    const items = EnumDictRegistry.get(id);
    if (items) {
      return { id, alias: id, comments: '', items };
    }

    return undefined;
  }

  /**
   * Get all registered dictionary definitions.
   * Merges locally added defines with EnumDictRegistry entries.
   */
  getAllDefine(): DictDefine[] {
    const result = new Map<string, DictDefine>(this.defines);

    // Merge in EnumDictRegistry entries not already present
    for (const [dictId, items] of EnumDictRegistry.getAll()) {
      if (!result.has(dictId)) {
        result.set(dictId, { id: dictId, alias: dictId, comments: '', items });
      }
    }

    return Array.from(result.values());
  }

  /**
   * Check if a definition exists.
   */
  has(id: string): boolean {
    return this.defines.has(id) || EnumDictRegistry.has(id);
  }

  /**
   * Parse an enum class into a DictDefine and register it.
   *
   * Reference: hsweb DefaultDictDefineRepository.parseEnumDict()
   *
   * @param dictId - Dictionary ID
   * @param enumObj - TypeScript enum object
   * @param options - Optional alias and comments
   */
  parseAndRegister(
    dictId: string,
    enumObj: object,
    options?: { alias?: string; comments?: string },
  ): DictDefine {
    EnumDictRegistry.registerEnum(dictId, enumObj);
    const items = EnumDictRegistry.get(dictId) ?? [];
    const define: DictDefine = {
      id: dictId,
      alias: options?.alias ?? dictId,
      comments: options?.comments ?? '',
      items,
    };
    this.addDefine(define);
    return define;
  }
}

/**
 * Interface for fetching dictionary definitions from a database.
 *
 * Reference: hsweb CompositeDictDefineRepository — getFromDb()
 */
export interface DictDefineDbSource {
  /**
   * Load a dictionary definition by ID from the database.
   * Should return undefined if not found or if status is disabled.
   */
  getDefineFromDb(id: string): Promise<DictDefine | undefined>;

  /**
   * Load all dictionary definitions from the database.
   */
  getAllDefinesFromDb(): Promise<DictDefine[]>;
}

/**
 * CompositeDictDefineRepository — merges in-memory (enum-parsed) defines
 * with DB-sourced defines, with caching support.
 *
 * Reference: hsweb CompositeDictDefineRepository
 *
 * Lookup priority:
 * 1. In-memory defines (from parseAndRegister / addDefine)
 * 2. EnumDictRegistry entries
 * 3. Local cache of DB-fetched defines
 * 4. DB source (if configured)
 *
 * Supports cache invalidation via handleClearCacheEvent().
 */
export class CompositeDictDefineRepository extends DictDefineRepository {
  private readonly dbCache = new Map<string, DictDefine>();
  private dbSource?: DictDefineDbSource;

  /**
   * Set the database source for dictionary definitions.
   *
   * Reference: hsweb CompositeDictDefineRepository autowires DefaultDictionaryService
   */
  setDbSource(source: DictDefineDbSource): void {
    this.dbSource = source;
  }

  /**
   * Handle cache clear event.
   *
   * Reference: hsweb CompositeDictDefineRepository.handleClearCacheEvent()
   *
   * @param event - The cache clear event
   */
  handleClearCacheEvent(event: ClearDictionaryCacheEvent): void {
    if (event.dictionaryId) {
      this.dbCache.delete(event.dictionaryId);
    } else {
      this.dbCache.clear();
    }
  }

  /**
   * Get a dictionary definition by ID, with DB fallback and caching.
   *
   * Reference: hsweb CompositeDictDefineRepository.getDefine()
   * — checks parent (in-memory), then cache, then DB
   */
  override getDefine(id: string): DictDefine | undefined {
    // 1. Check in-memory defines (parent)
    const local = super.getDefine(id);
    if (local) return local;

    // 2. Check DB cache
    const cached = this.dbCache.get(id);
    if (cached) return cached;

    // For sync access, return undefined; use getDefineAsync for DB fallback
    return undefined;
  }

  /**
   * Async version of getDefine with DB fallback.
   *
   * Reference: hsweb CompositeDictDefineRepository.getDefine() — reactive
   */
  async getDefineAsync(id: string): Promise<DictDefine | undefined> {
    // 1. Check in-memory
    const local = super.getDefine(id);
    if (local) return local;

    // 2. Check DB cache
    const cached = this.dbCache.get(id);
    if (cached) return cached;

    // 3. Fetch from DB
    if (this.dbSource) {
      const fromDb = await this.dbSource.getDefineFromDb(id);
      if (fromDb) {
        this.dbCache.set(id, fromDb);
        return fromDb;
      }
    }

    return undefined;
  }

  /**
   * Get all dictionary definitions, merging in-memory, enum registry, and DB sources.
   *
   * Reference: hsweb CompositeDictDefineRepository.getAllDefine()
   * — Flux.concat(super.getAllDefine(), dbQuery)
   */
  override getAllDefine(): DictDefine[] {
    // Start with parent (in-memory + EnumDictRegistry)
    return super.getAllDefine();
  }

  /**
   * Async version of getAllDefine that includes DB-sourced definitions.
   *
   * Reference: hsweb CompositeDictDefineRepository.getAllDefine()
   */
  async getAllDefineAsync(): Promise<DictDefine[]> {
    const result = new Map<string, DictDefine>();

    // 1. In-memory + EnumDictRegistry
    for (const define of super.getAllDefine()) {
      result.set(define.id, define);
    }

    // 2. DB source
    if (this.dbSource) {
      const dbDefines = await this.dbSource.getAllDefinesFromDb();
      for (const define of dbDefines) {
        if (!result.has(define.id)) {
          result.set(define.id, define);
          this.dbCache.set(define.id, define);
        }
      }
    }

    return Array.from(result.values());
  }

  /**
   * Clear the DB cache entirely or for a specific dictionary.
   */
  clearDbCache(dictId?: string): void {
    if (dictId) {
      this.dbCache.delete(dictId);
    } else {
      this.dbCache.clear();
    }
  }
}
