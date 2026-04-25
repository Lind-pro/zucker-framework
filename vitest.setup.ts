type MetadataPropertyKey = string | symbol | undefined;
type MetadataKey = unknown;
type MetadataValues = Map<MetadataKey, unknown>;
type PropertyMetadataStore = Map<MetadataPropertyKey, MetadataValues>;

const metadataStore = new WeakMap<object, PropertyMetadataStore>();

type ReflectWithMetadata = typeof Reflect & {
  metadata?: (
    metadataKey: MetadataKey,
    metadataValue: unknown,
  ) => (
    target: object,
    propertyKey?: string | symbol,
  ) => void;
  defineMetadata?: (
    metadataKey: MetadataKey,
    metadataValue: unknown,
    target: object,
    propertyKey?: string | symbol,
  ) => void;
  hasOwnMetadata?: (
    metadataKey: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ) => boolean;
  getMetadata?: (
    metadataKey: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ) => unknown;
  getOwnMetadata?: (
    metadataKey: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ) => unknown;
  getMetadataKeys?: (
    target: object,
    propertyKey?: string | symbol,
  ) => MetadataKey[];
  getOwnMetadataKeys?: (
    target: object,
    propertyKey?: string | symbol,
  ) => MetadataKey[];
  hasMetadata?: (
    metadataKey: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ) => boolean;
  deleteMetadata?: (
    metadataKey: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ) => boolean;
};

const reflectWithMetadata = Reflect as ReflectWithMetadata;

function getMetadataValues(
  target: object,
  propertyKey?: string | symbol,
  create = false,
): MetadataValues | undefined {
  let propertyStore = metadataStore.get(target);

  if (!propertyStore && create) {
    propertyStore = new Map();
    metadataStore.set(target, propertyStore);
  }

  if (!propertyStore) {
    return undefined;
  }

  let metadataValues = propertyStore.get(propertyKey);

  if (!metadataValues && create) {
    metadataValues = new Map();
    propertyStore.set(propertyKey, metadataValues);
  }

  return metadataValues;
}

if (!reflectWithMetadata.defineMetadata) {
  reflectWithMetadata.defineMetadata = (
    metadataKey,
    metadataValue,
    target,
    propertyKey,
  ) => {
    getMetadataValues(target, propertyKey, true)?.set(metadataKey, metadataValue);
  };
}

if (!reflectWithMetadata.metadata) {
  reflectWithMetadata.metadata = (metadataKey, metadataValue) =>
    (target, propertyKey) =>
      reflectWithMetadata.defineMetadata?.(
        metadataKey,
        metadataValue,
        target,
        propertyKey,
      );
}

if (!reflectWithMetadata.hasOwnMetadata) {
  reflectWithMetadata.hasOwnMetadata = (metadataKey, target, propertyKey) =>
    getMetadataValues(target, propertyKey)?.has(metadataKey) ?? false;
}

if (!reflectWithMetadata.getOwnMetadata) {
  reflectWithMetadata.getOwnMetadata = (metadataKey, target, propertyKey) =>
    getMetadataValues(target, propertyKey)?.get(metadataKey);
}

if (!reflectWithMetadata.getOwnMetadataKeys) {
  reflectWithMetadata.getOwnMetadataKeys = (target, propertyKey) =>
    Array.from(getMetadataValues(target, propertyKey)?.keys() ?? []);
}

if (!reflectWithMetadata.getMetadata) {
  reflectWithMetadata.getMetadata = (metadataKey, target, propertyKey) => {
    let current: object | null = target;

    while (current) {
      const value = getMetadataValues(current, propertyKey)?.get(metadataKey);
      if (value !== undefined) {
        return value;
      }
      current = Object.getPrototypeOf(current);
    }

    return undefined;
  };
}

if (!reflectWithMetadata.getMetadataKeys) {
  reflectWithMetadata.getMetadataKeys = (target, propertyKey) => {
    const keys = new Set<MetadataKey>();
    let current: object | null = target;

    while (current) {
      for (const key of reflectWithMetadata.getOwnMetadataKeys?.(current, propertyKey) ?? []) {
        keys.add(key);
      }
      current = Object.getPrototypeOf(current);
    }

    return Array.from(keys);
  };
}

if (!reflectWithMetadata.hasMetadata) {
  reflectWithMetadata.hasMetadata = (metadataKey, target, propertyKey) =>
    reflectWithMetadata.getMetadata?.(metadataKey, target, propertyKey) !== undefined;
}

if (!reflectWithMetadata.deleteMetadata) {
  reflectWithMetadata.deleteMetadata = (metadataKey, target, propertyKey) => {
    const propertyStore = metadataStore.get(target);
    const metadataValues = propertyStore?.get(propertyKey);

    if (!metadataValues?.delete(metadataKey)) {
      return false;
    }

    if (metadataValues.size === 0) {
      propertyStore?.delete(propertyKey);
    }

    if (propertyStore && propertyStore.size === 0) {
      metadataStore.delete(target);
    }

    return true;
  };
}

export {};
