export interface RdkitMolecule {
  is_valid(): boolean;
  get_svg(): string;
  delete(): void;
}
export interface RdkitSvgModule {
  get_mol(input: string): RdkitMolecule | null;
}
export class RdkitLoadError extends Error {}
export class InvalidSmilesError extends Error {}

let modulePromise: Promise<RdkitSvgModule> | undefined;
async function loadRdkit(): Promise<RdkitSvgModule> {
  if (!modulePromise) {
    modulePromise = import('@rdkit/rdkit')
      .then(async (module) => {
        const initialize = module.default as unknown as () => Promise<RdkitSvgModule>;
        return initialize();
      })
      .catch((error: unknown) => {
        modulePromise = undefined;
        throw new RdkitLoadError('Unable to load RDKit WASM', { cause: error });
      });
  }
  return modulePromise;
}

/** Release the WASM molecule on invalid input, success and every render failure. */
export async function renderSmilesSvg(
  smiles: string,
  module?: RdkitSvgModule,
): Promise<{ svg: string; durationMs: number }> {
  const rdkit = module ?? (await loadRdkit());
  const startedAt = Date.now();
  const molecule = rdkit.get_mol(smiles);
  if (!molecule) throw new InvalidSmilesError('Invalid SMILES');
  try {
    if (!molecule.is_valid()) throw new InvalidSmilesError('Invalid SMILES');
    return { svg: molecule.get_svg(), durationMs: Date.now() - startedAt };
  } finally {
    molecule.delete();
  }
}
