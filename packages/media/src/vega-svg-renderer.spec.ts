import { describe, expect, it, vi } from 'vitest';
import { renderVegaLiteSvg } from './vega-svg-renderer';

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
});
