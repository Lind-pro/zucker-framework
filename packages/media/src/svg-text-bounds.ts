/** Visible text rectangles in SVG viewBox coordinates for downstream layout. */
export function measureSvgTextBounds(svg: SVGSVGElement) {
  const inverse = svg.getScreenCTM?.()?.inverse?.();
  if (!inverse) return [];
  return Array.from(svg.querySelectorAll("text"))
    .filter((text) => text.textContent?.trim())
    .map((text) => {
      const rect = text.getBoundingClientRect();
      const corners = [
        [rect.left, rect.top],
        [rect.right, rect.top],
        [rect.left, rect.bottom],
        [rect.right, rect.bottom],
      ].map(([x, y]) => ({
        x: inverse.a * x + inverse.c * y + inverse.e,
        y: inverse.b * x + inverse.d * y + inverse.f,
      }));
      const left = Math.min(...corners.map((point) => point.x));
      const top = Math.min(...corners.map((point) => point.y));
      return {
        x: left,
        y: top,
        width: Math.max(...corners.map((point) => point.x)) - left,
        height: Math.max(...corners.map((point) => point.y)) - top,
      };
    })
    .filter((rect) => rect.width > 0 && rect.height > 0);
}
