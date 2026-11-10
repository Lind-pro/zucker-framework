import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { installConsumerAgentInstructions } from '../../tooling/agent-instructions.mjs';
import { validateProjectBundle, type ProjectBundle } from '../../tooling/project-templates.mjs';

/** Released versions shipped with this CLI build (dist/release-catalog.json). */
export interface ReleaseCatalog {
  versions: Record<string, string>;
  runtime?: { node: string; packageManager: string };
  server: { dependencies: Record<string, string>; devDependencies: Record<string, string> };
}

export const manifestDependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export function readReleaseCatalog(runtimeDirectory: string): ReleaseCatalog {
  const path = resolve(runtimeDirectory, 'release-catalog.json');
  if (!existsSync(path)) throw new Error('CLI release catalog is missing; build or reinstall the CLI package.');
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseCatalog;
}

export function readProjectBundle(runtimeDirectory: string): ProjectBundle {
  const path = join(runtimeDirectory, 'project-templates.json');
  if (!existsSync(path)) throw new Error('CLI project assets are missing; build or reinstall the CLI.');
  const bundle: unknown = JSON.parse(readFileSync(path, 'utf8'));
  validateProjectBundle(bundle);
  return bundle;
}

export function installInstructions(targetDir: string, bundle: ProjectBundle): void {
  const result = installConsumerAgentInstructions(targetDir, bundle.consumerInstructions);
  for (const warning of result.warnings) console.warn(warning);
}

/** Throws before any file is written when a workspace dependency has no released version. */
export function assertReleasedVersions(manifest: Record<string, unknown>, catalog: ReleaseCatalog): void {
  for (const field of manifestDependencyFields) {
    for (const [dependency, version] of Object.entries((manifest[field] ?? {}) as Record<string, unknown>)) {
      if (typeof version === 'string' && version.startsWith('workspace:') && !catalog.versions[dependency]) {
        throw new Error(`No release version found for ${dependency}`);
      }
    }
  }
}

/** Replace `workspace:` links with the fixed released versions; consumers never link to a checkout. */
export function pinReleasedVersions(manifest: Record<string, unknown>, catalog: ReleaseCatalog): void {
  for (const field of manifestDependencyFields) {
    const entries = manifest[field] as Record<string, string> | undefined;
    for (const [dependency, version] of Object.entries(entries ?? {})) {
      if (!version.startsWith('workspace:')) continue;
      const releasedVersion = catalog.versions[dependency];
      if (!releasedVersion) throw new Error(`No release version found for ${dependency}`);
      if (entries) entries[dependency] = releasedVersion;
    }
  }
}
