import { describe, expect, it } from 'vitest';
import { withMermaidMonochromeTheme } from './monochrome';

describe('monochrome Mermaid source', () => {
  it('overrides old themes and explicit colors without changing labels, links or dashes', () => {
    const source = `%%{init: {"theme":"dark"}}%%
flowchart LR
A[Input] --> B[Process]
classDef accent fill:#ffeeaa,stroke:rgb(255,0,0),color:blue,stroke-dasharray:5 5;
class A accent
linkStyle 0 stroke:red,stroke-width:2px;`;
    const result = withMermaidMonochromeTheme(source);
    expect(result).not.toContain('"theme":"dark"');
    expect(result).toContain('A[Input] --> B[Process]');
    expect(result).toContain('fill:#ffffff,stroke:#000000,color:#000000,stroke-dasharray:5 5');
    expect(result).toContain('linkStyle 0 stroke:#000000,stroke-width:2px');
    expect(withMermaidMonochromeTheme(result)).toBe(result);
  });
  it('retains sequence regions and labels with a white region background', () => {
    expect(withMermaidMonochromeTheme('sequenceDiagram\nrect rgb(230,200,255)\nA->>B: Result\nend'))
      .toContain('rect rgb(255,255,255)\nA->>B: Result\nend');
  });
});
