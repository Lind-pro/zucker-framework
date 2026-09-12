import { describe, expect, it } from 'vitest';
import { measureSvgTextBounds as svgLabelBounds } from './svg-text-bounds';
describe('SVG text coordinates', () => {
  it("projects visible text boxes back to viewBox units for safe sheet breaks", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = "<text>Complete label</text>";
    Object.defineProperty(svg, "getScreenCTM", {
      value: () => ({
        inverse: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: -10, f: -20 }),
      }),
    });
    Object.defineProperty(svg.querySelector("text")!, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 80, right: 240, bottom: 120 }),
    });
    expect(svgLabelBounds(svg)).toEqual([
      { x: 10, y: 20, width: 100, height: 20 },
    ]);
  });
});
