export interface VegaSvgView {
  toSVG(): Promise<string>;
  finalize(): void;
}
export interface VegaSvgModules {
  vega: {
    parse(spec: unknown): unknown;
    View: new (runtime: unknown, options: { renderer: 'none'; loader?: VegaLoader }) => VegaSvgView;
  };
  vegaLite: { compile(spec: Record<string, unknown>): { spec: unknown } };
}
export class VegaSvgRenderError extends Error {}

/** Vega loader interface subset used by the headless view. */
export interface VegaLoader {
  load(uri: string, options?: unknown): Promise<string>;
  sanitize(uri: string, options?: unknown): Promise<{ href: string }>;
  http(uri: string, options?: unknown): Promise<string>;
  file(filename: string): Promise<string>;
}

const refuse = (uri: string): Promise<never> =>
  Promise.reject(new Error(`External resource loading is disabled: ${String(uri).slice(0, 200)}`));

/**
 * Specs are often model-generated, so the default Vega loader (HTTP and local
 * file access in Node) is replaced by one that refuses every load. Inline
 * `values` data is unaffected.
 */
export const DENY_ALL_VEGA_LOADER: VegaLoader = {
  load: refuse,
  sanitize: refuse,
  http: refuse,
  file: refuse,
};

/** Throw if any `data` entry in the compiled Vega spec references a URL. */
function assertNoExternalData(spec: unknown): void {
  const data = (spec as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return;
  for (const entry of data) {
    if (entry && typeof entry === 'object' && 'url' in entry) {
      throw new Error('Vega data sources with "url" are not allowed; inline the values');
    }
  }
}
let modulesPromise: Promise<VegaSvgModules> | undefined;

async function loadModules(): Promise<VegaSvgModules> {
  if (!modulesPromise) {
    // Native import is required for vega-lite's top-level await when the consumer
    // compiles its application to CommonJS. Module names are fixed library peers.
    const dynamicImport = new Function('module', 'return import(module)') as (
      module: string,
    ) => Promise<unknown>;
    modulesPromise = Promise.all([dynamicImport('vega'), dynamicImport('vega-lite')])
      .then(([vega, vegaLite]) => ({
        vega: vega as VegaSvgModules['vega'],
        vegaLite: ((vegaLite as { default?: unknown }).default ??
          vegaLite) as VegaSvgModules['vegaLite'],
      }))
      .catch((error: unknown) => {
        modulesPromise = undefined;
        throw error;
      });
  }
  return modulesPromise;
}

/** Compile Vega-Lite and always finalize its headless view after SVG extraction. */
export async function renderVegaLiteSvg(
  spec: Record<string, unknown>,
  modules?: VegaSvgModules,
): Promise<{ svg: string; durationMs: number }> {
  const { vega, vegaLite } = modules ?? (await loadModules());
  const startedAt = Date.now();
  let view: VegaSvgView | undefined;
  try {
    const compiled = vegaLite.compile(spec).spec;
    assertNoExternalData(compiled);
    const runtime = vega.parse(compiled);
    view = new vega.View(runtime, { renderer: 'none', loader: DENY_ALL_VEGA_LOADER });
    const svg = await view.toSVG();
    return { svg, durationMs: Date.now() - startedAt };
  } catch (error) {
    throw new VegaSvgRenderError('Vega rendering failed', { cause: error });
  } finally {
    view?.finalize();
  }
}
