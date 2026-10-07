import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}));

import { renderMermaidSvg } from './render';

describe('renderMermaidSvg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mermaidMocks.render.mockResolvedValue({ svg: '<svg></svg>' });
  });

  it('normalizes source and initializes the responsive profile', async () => {
    const source = 'sequenceDiagram\n  A->>B: 请求';

    await expect(renderMermaidSvg(source, { idPrefix: 'admin' })).resolves.toEqual({
      svg: '<svg></svg>',
      normalizedSource: `${source}\n`,
    });
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        htmlLabels: false,
        flowchart: { useMaxWidth: true, htmlLabels: false },
        sequence: { useMaxWidth: true },
      }),
    );
    expect(mermaidMocks.render.mock.calls[0]?.[1]).toBe(`${source}\n`);
  });

  it('uses fixed-size SVG settings for exports', async () => {
    await renderMermaidSvg('flowchart TD\nA-->B', { profile: 'export' });

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: { useMaxWidth: false, htmlLabels: false },
        sequence: { useMaxWidth: false },
      }),
    );
  });

  it('restores Mermaid numeric escapes in visible SVG labels', async () => {
    mermaidMocks.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text><tspan>clip&amp;#40;x&amp;#41; &amp;#38; x &amp;#60; 2</tspan></text></svg>',
    });
    const result = await renderMermaidSvg('flowchart TD\nA["clip#40;x#41; #38; x #60; 2"]');
    const parsed = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    expect(parsed.querySelector('text')?.textContent).toBe('clip(x) & x < 2');
    expect(parsed.querySelector('script')).toBeNull();
  });

  it('includes text beyond Mermaid viewBox without changing paths and cleans its measurement container', async () => {
    const previous = Object.getOwnPropertyDescriptor(SVGSVGElement.prototype, 'getScreenCTM');
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }) });
    const measure = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 10, 160, 240));
    const original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 200"><path d="M0 0L10 10"/><text>Complete message</text></svg>';
    mermaidMocks.render.mockResolvedValueOnce({ svg: original });
    try {
      const result = await renderMermaidSvg('sequenceDiagram\nA->>A: Complete message', { profile: 'export', monochrome: true });
      expect(result.svg).toContain('viewBox="1 6 168 248"');
      expect(result.svg).toContain('<path d="M0 0L10 10"/>');
      expect(result.svg).toContain('Complete message');
      expect(document.querySelector('[data-mermaid-bounds]')).toBeNull();
      expect(mermaidMocks.initialize.mock.lastCall?.[0].themeCSS).toContain('text {');
    } finally {
      measure.mockRestore();
      if (previous) Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', previous);
      else Reflect.deleteProperty(SVGSVGElement.prototype, 'getScreenCTM');
    }
  });

  it('removes measurement elements when layout measurement fails', async () => {
    const previous = Object.getOwnPropertyDescriptor(SVGSVGElement.prototype, 'getScreenCTM');
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }) });
    const measure = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => { throw new Error('measurement failed'); });
    mermaidMocks.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>Message</text></svg>' });
    try {
      await expect(renderMermaidSvg('sequenceDiagram\nA->>B: Message')).rejects.toThrow('measurement failed');
      expect(document.querySelector('[data-mermaid-bounds]')).toBeNull();
    } finally {
      measure.mockRestore();
      if (previous) Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', previous);
      else Reflect.deleteProperty(SVGSVGElement.prototype, 'getScreenCTM');
    }
  });

  it('keeps intentionally cropped lifeline tails out of the viewport when all text fits', async () => {
    const previous = Object.getOwnPropertyDescriptor(SVGSVGElement.prototype, 'getScreenCTM');
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }) });
    const measure = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 70, 70));
    const original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 0L10 9999"/><text>Message</text></svg>';
    mermaidMocks.render.mockResolvedValueOnce({ svg: original });
    try {
      expect((await renderMermaidSvg('sequenceDiagram\nA->>A: Message')).svg).toBe(original);
    } finally {
      measure.mockRestore();
      if (previous) Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', previous);
      else Reflect.deleteProperty(SVGSVGElement.prototype, 'getScreenCTM');
    }
  });

  it('renders all state self-transition labels without changing the returned source', async () => {
    const source = 'stateDiagram-v2\nA --> A: first action\nA --> A: second action';
    const result = await renderMermaidSvg(source);
    expect(result.normalizedSource).toBe(source);
    expect(mermaidMocks.render.mock.lastCall?.[1]).toContain('first action<br/>second action');
    expect(mermaidMocks.initialize.mock.lastCall?.[0].state).toEqual({
      useMaxWidth: true,
      rankSpacing: 180,
      nodeSpacing: 70,
    });
  });

  it('selects a readable page orientation while keeping the saved graph unchanged', async () => {
    const source = 'flowchart LR\nA[入力部]-->B[処理部]';
    mermaidMocks.render
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 2000 300"></svg>' })
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 700 650"></svg>' });
    const result = await renderMermaidSvg(source, {
      profile: 'export',
      fitToPage: { width: 567, height: 756 },
    });
    expect(result.svg).toContain('700 650');
    expect(result.normalizedSource).toBe('flowchart LR\nA["入力部"]-->B["処理部"]');
    expect(mermaidMocks.render.mock.calls[1][1]).toBe('flowchart TB\nA["入力部"]-->B["処理部"]');
    expect(mermaidMocks.initialize.mock.lastCall?.[0].flowchart).toMatchObject({
      nodeSpacing: 30,
      rankSpacing: 30,
      subGraphTitleMargin: { top: 8, bottom: 24 },
    });
  });

  it('wraps mixed-language ACK labels and keeps cross-participant text away from intermediate lifelines', async () => {
    const source = 'sequenceDiagram\nS-->>G: 커밋 ACK\\ngatewayId, bootEpoch, 연속 커밋 워터마크';
    await renderMermaidSvg(source, { profile: 'export', fitToPage: { width: 567, height: 756 } });
    const renderedSource = mermaidMocks.render.mock.lastCall?.[1];
    expect(renderedSource).toContain('커밋 ACK<br/>');
    expect(renderedSource).not.toContain('\\n');
    expect(renderedSource.replaceAll('<br/>', '').replace(/\s/gu, '')).toBe(source.replace('\\n', '').replace(/\s/gu, ''));
    expect(mermaidMocks.initialize.mock.lastCall?.[0].sequence).toMatchObject({ messageAlign: 'left', wrap: true });
  });

  it('keeps the original orientation when it fits better or the alternative fails', async () => {
    mermaidMocks.render
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 500 500"></svg>' })
      .mockRejectedValueOnce(new Error('layout failure'));
    await expect(
      renderMermaidSvg('flowchart LR\nA-->B', { fitToPage: { width: 567, height: 756 } }),
    ).resolves.toMatchObject({ svg: '<svg viewBox="0 0 500 500"></svg>' });
  });

  it('also evaluates an alternative for a valid indented graph declaration', async () => {
    await renderMermaidSvg('  flowchart LR\nA-->B', { fitToPage: { width: 567, height: 756 } });
    expect(mermaidMocks.render.mock.calls[1][1]).toBe('  flowchart TB\nA-->B');
  });

  it('uses black lines and white fills for an explicitly monochrome render, then restores the normal theme', async () => {
    await renderMermaidSvg('flowchart TD\nA[入力]-->B[出力]', {
      profile: 'export',
      monochrome: true,
    });

    expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'base',
        themeCSS: expect.stringContaining('paint-order: stroke'),
        themeVariables: expect.objectContaining({
          primaryColor: '#ffffff',
          primaryBorderColor: '#000000',
          primaryTextColor: '#000000',
          lineColor: '#000000',
          clusterBkg: '#ffffff',
          actorBkg: '#ffffff',
          noteBkgColor: '#ffffff',
        }),
      }),
    );

    await renderMermaidSvg('flowchart TD\nA-->B');
    expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'default' }),
    );
    expect(mermaidMocks.initialize.mock.lastCall?.[0]).not.toHaveProperty('themeVariables');
    expect(mermaidMocks.initialize.mock.lastCall?.[0]).not.toHaveProperty('themeCSS');
  });

  it('selects an orthogonal direction for a simple state diagram without changing the saved source', async () => {
    const source = 'stateDiagram-v2\n[*] --> Pending\nPending --> Committed: durable ACK\nCommitted --> [*]';
    mermaidMocks.render
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 2000 300"></svg>' })
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 600 650"></svg>' });
    const result = await renderMermaidSvg(source, { fitToPage: { width: 567, height: 756 } });
    expect(result.svg).toContain('600 650');
    expect(result.normalizedSource).toBe(source);
    expect(mermaidMocks.render.mock.calls[1][1]).toBe(source.replace('stateDiagram-v2\n', 'stateDiagram-v2\ndirection LR\n'));
  });

  it('keeps a nested state direction scoped to its original compound state', async () => {
    const source = 'stateDiagram-v2\nstate Active {\n direction LR\n A --> B\n}';
    await renderMermaidSvg(source, { fitToPage: { width: 567, height: 756 } });
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
    expect(mermaidMocks.render.mock.calls[0][1]).toBe(source);
  });

  it('serializes concurrent renders because Mermaid configuration is global', async () => {
    let active = 0;
    let maxActive = 0;
    mermaidMocks.render.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { svg: '<svg></svg>' };
    });

    await Promise.all([
      renderMermaidSvg('flowchart TD\nA-->B'),
      renderMermaidSvg('sequenceDiagram\nA->>B: x'),
    ]);

    expect(maxActive).toBe(1);
  });

  it('continues the queue after one render fails', async () => {
    mermaidMocks.render
      .mockRejectedValueOnce(new Error('parse failed'))
      .mockResolvedValueOnce({ svg: '<svg id="recovered"></svg>' });

    await expect(renderMermaidSvg('flowchart TD\nA-->', {})).rejects.toThrow('parse failed');
    await expect(renderMermaidSvg('flowchart TD\nA-->B', {})).resolves.toMatchObject({
      svg: '<svg id="recovered"></svg>',
    });
  });
});
