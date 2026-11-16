import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Node canonicalizes module URLs; argv may still use a symlink (notably macOS /var). */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch (error) {
    // Imports from eval/test hosts may have no existing filesystem entrypoint.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}
