/** Shared appearance for browser Mermaid and source-based render services. */
export const MERMAID_MONOCHROME_THEME = {
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
            // Pie legends must remain distinguishable after removing hue.
            pie1: '#ffffff', pie2: '#dddddd', pie3: '#bbbbbb', pie4: '#999999',
            pie5: '#eeeeee', pie6: '#cccccc', pie7: '#aaaaaa', pie8: '#888888',
            pie9: '#eeeeee', pie10: '#cccccc', pie11: '#aaaaaa', pie12: '#888888',
            pieSectionTextColor: '#000000', pieLegendTextColor: '#000000',
            pieStrokeColor: '#000000', pieOuterStrokeColor: '#000000',
          };

/** Apply a monochrome presentation without changing labels or graph topology. */
export function withMermaidMonochromeTheme(source: string): string {
  const body = source.replace(/%%\{[\s\S]*?\}%%/g, '').trim()
    .replace(/^([ \t]*(?:style|classDef|linkStyle)\b[^\n]*)/gm, line =>
      line.replace(/\b(fill|stroke|color|background-color)\s*:\s*(rgba?\([^)]*\)|[^,;\n]+)/gi,
        (_, property: string, value: string) => `${property}:${/^(none|transparent)\s*$/i.test(value) ? value : /^(fill|background-color)$/i.test(property) ? '#ffffff' : '#000000'}`))
    .replace(/^(\s*rect\s+)(?:rgba?\([^)]*\)|#[\da-f]+)\s*$/gmi, '$1rgb(255,255,255)');
  const config = {
    theme: 'base', themeVariables: MERMAID_MONOCHROME_THEME,
    htmlLabels: false, flowchart: { htmlLabels: false }, securityLevel: 'strict',
  };
  return `%%{init: ${JSON.stringify(config)}}%%\n${body}`;
}
