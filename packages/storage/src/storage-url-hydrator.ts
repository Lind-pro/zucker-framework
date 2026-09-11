export interface StorageUrlHydrationOptions {
  /** The application must establish ownership before allowing a key to be signed. */
  allowedStorageKeys: ReadonlySet<string>;
  getDownloadUrl: (key: string) => Promise<string>;
  storageKeyField: string;
  urlFields: readonly string[];
}

type UnknownRecord = Record<string, unknown>;
function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Clone a JSON-like response graph and resolve only authorized object keys.
 * Dates/class instances pass through. Signatures are deduplicated within this
 * call, never cached between requests. A signing failure rejects the whole call;
 * generated URLs never mutate the source graph that might later be persisted.
 */
export async function hydrateStorageUrls<T>(
  value: T,
  options: StorageUrlHydrationOptions,
): Promise<T> {
  const signedUrls = new Map<string, Promise<string>>();
  const hydrate = async (current: unknown): Promise<unknown> => {
    if (Array.isArray(current)) return Promise.all(current.map(hydrate));
    if (!isPlainRecord(current)) return current;
    const entries = await Promise.all(
      Object.entries(current).map(async ([key, nested]) => [key, await hydrate(nested)] as const),
    );
    const result: UnknownRecord = Object.fromEntries(entries);
    const key = result[options.storageKeyField];
    if (typeof key === 'string' && key.length > 0 && options.allowedStorageKeys.has(key)) {
      let signed = signedUrls.get(key);
      if (!signed) {
        signed = options.getDownloadUrl(key);
        signedUrls.set(key, signed);
      }
      const url = await signed;
      for (const field of options.urlFields) {
        Object.defineProperty(result, field, {
          value: url,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return result;
  };
  return hydrate(value) as Promise<T>;
}
