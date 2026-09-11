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
    });
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
