export interface VegaSvgView {
  toSVG(): Promise<string>;
  finalize(): void;
}
export interface VegaSvgModules {
  vega: {
    parse(spec: unknown): unknown;
    View: new (runtime: unknown, options: { renderer: 'none' }) => VegaSvgView;
  };
  vegaLite: { compile(spec: Record<string, unknown>): { spec: unknown } };
}
export class VegaSvgRenderError extends Error {}
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
    const runtime = vega.parse(vegaLite.compile(spec).spec);
    view = new vega.View(runtime, { renderer: 'none' });
    const svg = await view.toSVG();
    return { svg, durationMs: Date.now() - startedAt };
  } catch (error) {
    throw new VegaSvgRenderError('Vega rendering failed', { cause: error });
  } finally {
    view?.finalize();
  }
}
