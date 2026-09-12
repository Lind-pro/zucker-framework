import { MERMAID_MONOCHROME_THEME, withMermaidMonochromeTheme } from './monochrome';
import { detectMermaidDiagramType, sanitizeMermaidCode } from './sanitize';
import { prepareStateLayout } from './state-layout';
import { prepareSequenceLayout } from './sequence-layout';
import { sanitizeSvgMarkup } from '../svg-sanitize';
import { measureSvgTextBounds } from '../svg-text-bounds';

export type MermaidRenderProfile = 'responsive' | 'export';

export type MermaidRenderOptions = {
  profile?: MermaidRenderProfile;
  idPrefix?: string;
  /** Use a white background with black diagram lines and labels. */
  monochrome?: boolean;
  /** Fit graph layout to a target page without changing labels or connections. */
  fitToPage?: { width: number; height: number };
};

export type MermaidRenderResult = {
  svg: string;
  normalizedSource: string;
};

let renderSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();

function createConfiguration(
  profile: MermaidRenderProfile,
  monochrome: boolean,
  hasSelfTransitions: boolean,
  compact: boolean,
) {
  const useMaxWidth = profile === 'responsive';
  return {
    startOnLoad: false,
    theme: monochrome ? ('base' as const) : ('default' as const),
    ...(monochrome
      ? {
          // Text remains legible when an incoming cluster edge or a lifeline
          // passes behind it. Keep the original paths and graph topology intact.
          themeCSS: 'text { paint-order: stroke; stroke: #ffffff !important; stroke-width: 3px !important; stroke-linejoin: round; }',
          themeVariables: MERMAID_MONOCHROME_THEME,
        }
      : {}),
    securityLevel: 'strict' as const,
    fontFamily: 'SimSun, SimHei, sans-serif',
    htmlLabels: false,
    flowchart: {
      useMaxWidth,
      htmlLabels: false,
      ...(compact ? {
        nodeSpacing: 30,
        rankSpacing: 30,
        subGraphTitleMargin: { top: 8, bottom: 24 },
      } : {}),
    },
    sequence: {
      useMaxWidth,
      ...(compact
        ? {
            wrap: true,
            width: 150,
            actorMargin: 20,
            height: 55,
            messageMargin: 24,
            mirrorActors: false,
            wrapPadding: 8,
            messageAlign: 'left' as const,
          }
        : {}),
    },
    gantt: { useMaxWidth },
    class: { useMaxWidth },
    state: {
      useMaxWidth,
      ...(hasSelfTransitions ? { rankSpacing: 180, nodeSpacing: 70 } : {}),
    },
    er: { useMaxWidth },
    suppressErrorRendering: true,
  };
}

function fitScale(svg: string, page: { width: number; height: number }): number {
  const values = svg
    .match(/\bviewBox=["']([^"']+)["']/i)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !values ||
    values.length !== 4 ||
    !values.every(Number.isFinite) ||
    values[2] <= 0 ||
    values[3] <= 0
  )
    return 0;
  return Math.min(page.width / values[2], page.height / values[3]);
}

function orthogonalFlowchart(source: string): string {
  const direction: Record<string, string> = { LR: 'TB', RL: 'BT', TB: 'LR', TD: 'LR', BT: 'RL' };
  return source.replace(
    /^([ \t]*)(flowchart|graph)([ \t]+)(LR|RL|TB|TD|BT)\b/m,
    (_, indent: string, kind: string, space: string, axis: string) =>
      `${indent}${kind}${space}${direction[axis]}`,
  );
}

function orthogonalStateDiagram(source: string): string {
  // Do not change directions scoped to compound states.
  if (/^\s*state\b[^\n]*\{/m.test(source)) return source;
  const direction: Record<string, string> = { LR: 'TB', RL: 'BT', TB: 'LR', TD: 'LR', BT: 'RL' };
  if (/^[ \t]*direction[ \t]+(?:LR|RL|TB|TD|BT)\b/m.test(source)) {
    return source.replace(/^([ \t]*direction[ \t]+)(LR|RL|TB|TD|BT)\b/m,
      (_, prefix: string, axis: string) => prefix + direction[axis]);
  }
  return source.replace(/^([ \t]*stateDiagram(?:-v2)?[^\n]*)(\n|$)/m, '$1\ndirection LR$2');
}

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Mermaid can underestimate wrapped self-message width. Expand, never crop. */
function includeVisibleBounds(source: string): string {
  if (typeof document === 'undefined' || !document.body) return source;
  const clean = sanitizeSvgMarkup(source);
  if (!clean) throw new Error('Mermaid returned invalid SVG markup');
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.localName !== 'svg' || !(svg instanceof SVGSVGElement)) return source;
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return source;
  const holder = document.createElement('div');
  holder.dataset.mermaidBounds = '';
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:1200px;';
  // Measuring geometry must not fetch external resources a second time.
  for (const element of Array.from(svg.querySelectorAll('[href], [xlink\\:href]'))) {
    for (const attr of ['href', 'xlink:href']) {
      const value = element.getAttribute(attr);
      if (value && !value.startsWith('#')) element.removeAttribute(attr);
    }
  }
  holder.append(svg);
  document.body.append(holder);
  try {
    // Lifelines may intentionally extend beyond the original viewport.
    // Preserve the existing plot, expanding only for actual clipped text.
    const labels = measureSvgTextBounds(svg);
    if (!labels.length) return source;
    const left = Math.min(...labels.map(rect => rect.x));
    const top = Math.min(...labels.map(rect => rect.y));
    const right = Math.max(...labels.map(rect => rect.x + rect.width));
    const bottom = Math.max(...labels.map(rect => rect.y + rect.height));
    const x = left < box[0] ? left - 4 : box[0];
    const y = top < box[1] ? top - 4 : box[1];
    const width = (right > box[0] + box[2] ? right + 4 : box[0] + box[2]) - x;
    const height = (bottom > box[1] + box[3] ? bottom + 4 : box[1] + box[3]) - y;
    if (x === box[0] && y === box[1] && width === box[2] && height === box[3]) return source;
    return source.replace(/\bviewBox=(["'])[^"']*\1/i, `viewBox="${x} ${y} ${width} ${height}"`);
  } finally {
    holder.remove();
  }
}

export function renderMermaidSvg(
  source: string,
  options: MermaidRenderOptions = {},
): Promise<MermaidRenderResult> {
  const normalizedSource = sanitizeMermaidCode(source);
  const stateLayout =
    detectMermaidDiagramType(normalizedSource) === 'state'
      ? prepareStateLayout(normalizedSource)
      : { source: normalizedSource, hasSelfTransitions: false };
  const profile = options.profile ?? 'responsive';
  const idPrefix = options.idPrefix ?? 'mermaid';
  const renderSource =
    options.fitToPage && detectMermaidDiagramType(normalizedSource) === 'sequence'
      ? prepareSequenceLayout(stateLayout.source)
      : stateLayout.source;

  return enqueueRender(async () => {
    const { default: mermaid } = await import('mermaid');
    renderSequence += 1;
    mermaid.initialize(
      createConfiguration(
        profile,
        options.monochrome ?? false,
        stateLayout.hasSelfTransitions,
        Boolean(options.fitToPage),
      ),
    );
    const id = `${idPrefix}-${Date.now()}-${renderSequence}`;
    let { svg } = await mermaid.render(id, options.monochrome ? withMermaidMonochromeTheme(renderSource) : renderSource);
    const diagramType = detectMermaidDiagramType(normalizedSource);
    if (options.fitToPage && (diagramType === 'flowchart' || diagramType === 'state')) {
      const alternate = diagramType === 'flowchart'
        ? orthogonalFlowchart(stateLayout.source)
        : orthogonalStateDiagram(stateLayout.source);
      if (alternate !== stateLayout.source) {
        try {
          const candidate = await mermaid.render(`${id}-alternate`, options.monochrome ? withMermaidMonochromeTheme(alternate) : alternate);
          if (fitScale(candidate.svg, options.fitToPage) > fitScale(svg, options.fitToPage)) {
            svg = candidate.svg;
          }
        } catch {
          // An optional layout candidate must not invalidate a renderable source.
        }
      }
    }
    return { svg: includeVisibleBounds(svg), normalizedSource };
  });
}
