import { detectMermaidDiagramType, sanitizeMermaidCode } from './sanitize';
import { prepareStateLayout } from './state-layout';
import { prepareSequenceLayout } from './sequence-layout';

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
          themeVariables: {
            background: '#ffffff',
            primaryColor: '#ffffff',
            primaryTextColor: '#000000',
            primaryBorderColor: '#000000',
            secondaryColor: '#ffffff',
            secondaryTextColor: '#000000',
            secondaryBorderColor: '#000000',
            tertiaryColor: '#ffffff',
            tertiaryTextColor: '#000000',
            tertiaryBorderColor: '#000000',
            lineColor: '#000000',
            textColor: '#000000',
            mainBkg: '#ffffff',
            nodeBorder: '#000000',
            nodeTextColor: '#000000',
            clusterBkg: '#ffffff',
            clusterBorder: '#000000',
            edgeLabelBackground: '#ffffff',
            actorBkg: '#ffffff',
            actorBorder: '#000000',
            actorTextColor: '#000000',
            actorLineColor: '#000000',
            signalColor: '#000000',
            signalTextColor: '#000000',
            labelBoxBkgColor: '#ffffff',
            labelBoxBorderColor: '#000000',
            labelTextColor: '#000000',
            loopTextColor: '#000000',
            noteBkgColor: '#ffffff',
            noteBorderColor: '#000000',
            noteTextColor: '#000000',
            activationBkgColor: '#ffffff',
            activationBorderColor: '#000000',
            attributeBackgroundColorOdd: '#ffffff',
            attributeBackgroundColorEven: '#ffffff',
          },
        }
      : {}),
    securityLevel: 'strict' as const,
    fontFamily: 'SimSun, SimHei, sans-serif',
    htmlLabels: false,
    flowchart: {
      useMaxWidth,
      htmlLabels: false,
      ...(compact ? { nodeSpacing: 30, rankSpacing: 30 } : {}),
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

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
    let { svg } = await mermaid.render(id, renderSource);
    if (options.fitToPage && detectMermaidDiagramType(normalizedSource) === 'flowchart') {
      const alternate = orthogonalFlowchart(stateLayout.source);
      if (alternate !== stateLayout.source) {
        try {
          const candidate = await mermaid.render(`${id}-alternate`, alternate);
          if (fitScale(candidate.svg, options.fitToPage) > fitScale(svg, options.fitToPage)) {
            svg = candidate.svg;
          }
        } catch {
          // An optional layout candidate must not invalidate a renderable source.
        }
      }
    }
    return { svg, normalizedSource };
  });
}
