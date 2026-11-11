/**
 * Plain-data connection descriptor for private file storage (local disk or S3/R2-compatible): profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type StorageConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface StorageConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: StorageConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface StorageConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly StorageConnectionDescriptorField[];
  };
}

/** Private files: `FILES_STORAGE_PROVIDER` selects local disk or an S3/R2-compatible bucket. */
export const PRIVATE_FILES_CONNECTION_DESCRIPTOR: StorageConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'private-files', name: 'Private file storage (S3 / R2)', labelKey: 'connections.private-files', category: 'Storage', categoryKey: 'connections.category.storage',
    fields: Object.freeze<StorageConnectionDescriptorField[]>([
      { key: 'FILES_STORAGE_PROVIDER', label: 'Storage type', labelKey: 'connections.field.FILES_STORAGE_PROVIDER', type: 'select', options: ['local', 's3'], defaultValue: 'local' },
      { key: 'FILES_S3_BUCKET', label: 'Bucket', labelKey: 'connections.field.FILES_S3_BUCKET', type: 'text' },
      { key: 'FILES_S3_REGION', label: 'Region', labelKey: 'connections.field.FILES_S3_REGION', type: 'text', defaultValue: 'us-east-1' },
      { key: 'FILES_S3_ENDPOINT', label: 'S3-compatible endpoint', labelKey: 'connections.field.FILES_S3_ENDPOINT', type: 'url' },
      { key: 'FILES_S3_ACCESS_KEY_ID', label: 'Access key ID', labelKey: 'connections.field.FILES_S3_ACCESS_KEY_ID', type: 'secret' },
      { key: 'FILES_S3_SECRET_ACCESS_KEY', label: 'Secret access key', labelKey: 'connections.field.FILES_S3_SECRET_ACCESS_KEY', type: 'secret' },
      { key: 'FILES_S3_FORCE_PATH_STYLE', label: 'Use path-style addressing (empty: chosen by endpoint)', labelKey: 'connections.field.FILES_S3_FORCE_PATH_STYLE', type: 'boolean' },
    ]) }),
});
