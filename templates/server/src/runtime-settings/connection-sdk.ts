import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const localRequire = createRequire(typeof __filename === 'string' ? __filename : resolve(process.cwd(), 'package.json'));
/** Resolve an optional SDK from its owning package without loading it or contacting the provider. */
export function connectionSdkAvailable(owner: string, dependency: string): boolean {
  try { createRequire(localRequire.resolve(owner)).resolve(dependency); return true; } catch { return false; }
}
