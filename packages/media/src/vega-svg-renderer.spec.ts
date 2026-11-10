import { describe, expect, it, vi } from 'vitest';
import { DENY_ALL_VEGA_LOADER, VegaSvgRenderError, renderVegaLiteSvg } from './vega-svg-renderer';

describe('renderVegaLiteSvg', () => {
  it('finalizes the headless view after success and SVG failure', async () => {
    const finalize = vi.fn();
    const toSVG = vi.fn(async () => '<svg/>');
    const modules = {
      vegaLite: { compile: (spec: Record<string, unknown>) => ({ spec }) },
      vega: {
        parse: (spec: unknown) => spec,
        View: class {
          toSVG = toSVG;
          finalize = finalize;
        },
      },
    };
    await expect(renderVegaLiteSvg({}, modules)).resolves.toMatchObject({ svg: '<svg/>' });
    expect(finalize).toHaveBeenCalledTimes(1);
    const error = new Error('failed');
    toSVG.mockRejectedValueOnce(error);
    await expect(renderVegaLiteSvg({}, modules)).rejects.toMatchObject({ cause: error });
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it('refuses external data and passes a deny-all loader to the view', async () => {
    const options: unknown[] = [];
    const modules = {
      vegaLite: { compile: (spec: Record<string, unknown>) => ({ spec }) },
      vega: {
        parse: (spec: unknown) => spec,
        View: class {
          constructor(_runtime: unknown, viewOptions: unknown) {
            options.push(viewOptions);
          }
          toSVG = async () => '<svg/>';
          finalize = () => undefined;
        },
      },
    };
    await expect(renderVegaLiteSvg({ data: [{ name: 'x', url: 'file:///etc/passwd' }] }, modules))
      .rejects.toBeInstanceOf(VegaSvgRenderError);
    await renderVegaLiteSvg({ data: [{ name: 'x', values: [] }] }, modules);
    expect(options).toEqual([{ renderer: 'none', loader: DENY_ALL_VEGA_LOADER }]);
    await expect(DENY_ALL_VEGA_LOADER.load('http://169.254.169.254/')).rejects.toThrow('disabled');
    await expect(DENY_ALL_VEGA_LOADER.sanitize('/etc/passwd')).rejects.toThrow('disabled');
  });
});
