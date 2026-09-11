/** Consumer-owned names and expected repositories for an immutable image set. */
export type ImageManifestComponents = Record<string, { repository: string }>;
export type ImageManifest = Record<string, string>;

export interface ImageManifestIdentity {
  components: ImageManifestComponents;
  sourceSha: string;
  runId: string;
}

export interface MergeImageManifestOptions extends ImageManifestIdentity {
  currentImages: Partial<Record<string, string>>;
  previous?: ImageManifest;
}

/** Parse the portable key=value format without accepting duplicate keys. */
export function parseKeyValueManifest(contents: string, label = 'manifest'): ImageManifest {
  const entries: ImageManifest = Object.create(null) as ImageManifest;
  for (const line of contents.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid manifest line in ${label}`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(entries, key)) throw new Error(`Duplicate manifest key ${key} in ${label}`);
    entries[key] = line.slice(separator + 1);
  }
  return entries;
}

function validateSha(value: string | undefined, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${label} must be a full Git SHA`);
}

function validateIdentity(identity: ImageManifestIdentity): void {
  validateSha(identity.sourceSha, 'source_sha');
  if (!/^\d+$/.test(identity.runId)) throw new Error('candidate_run_id must be numeric');
}

function validateImage(
  key: string,
  value: string | undefined,
  components: ImageManifestComponents,
): void {
  const [repository, digest, extra] = (value ?? '').split('@');
  if (
    repository !== components[key].repository ||
    !/^sha256:[0-9a-f]{64}$/.test(digest ?? '') ||
    extra !== undefined
  ) {
    throw new Error(`${key} must use its expected repository and digest`);
  }
}

/** Merge current digests with unchanged images, retaining each image's source SHA. */
export function mergeImageManifest(options: MergeImageManifestOptions): ImageManifest {
  const { components, sourceSha, runId, currentImages, previous } = options;
  validateIdentity(options);
  if (previous?.schema_version && previous.schema_version !== '2') {
    throw new Error('Previous manifest has an unsupported schema version');
  }
  if (previous) validateSha(previous.source_sha, 'previous source_sha');

  const merged: ImageManifest = {
    schema_version: '2',
    source_sha: sourceSha,
    candidate_run_id: runId,
  };
  for (const key of Object.keys(components)) {
    const currentImage = currentImages[key];
    if (currentImage !== undefined) {
      validateImage(key, currentImage, components);
      merged[`${key}_source_sha`] = sourceSha;
      merged[key] = currentImage;
      continue;
    }
    if (!previous?.[key]) throw new Error(`No current or previous digest is available for ${key}`);
    validateImage(key, previous[key], components);
    const componentSource = previous[`${key}_source_sha`] ?? previous.source_sha;
    validateSha(componentSource, `${key}_source_sha`);
    merged[`${key}_source_sha`] = componentSource;
    merged[key] = previous[key];
  }
  return merged;
}

/** Verify a complete candidate against the exact source and run selected by the consumer. */
export function verifyImageManifest(
  manifest: ImageManifest,
  identity: ImageManifestIdentity,
): void {
  validateIdentity(identity);
  if (manifest.schema_version !== '2')
    throw new Error('Candidate manifest schema_version must be 2');
  if (manifest.source_sha !== identity.sourceSha)
    throw new Error('Candidate manifest source_sha does not match release source');
  if (manifest.candidate_run_id !== identity.runId)
    throw new Error('Candidate manifest run id does not match selected run');
  for (const key of Object.keys(identity.components)) {
    validateSha(manifest[`${key}_source_sha`], `${key}_source_sha`);
    validateImage(key, manifest[key], identity.components);
  }
}
