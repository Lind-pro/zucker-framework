// Shared raster budget. Chromium allocates the capture bitmap in DEVICE pixels,
// so a 2x display doubles both edges of the same CSS-pixel region. Every caller
// must convert through devicePixelRatio before comparing against these.
const CAPTURE_LIMITS = {
  maxEdgeDevicePx: 16384,
  maxDevicePixels: 64 * 1024 * 1024,
};
function captureScale(dpr) {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}
function captureFits(width, height, dpr) {
  const scale = captureScale(dpr);
  return (
    [width, height].every((n) => Number.isFinite(n) && n > 0) &&
    width * scale <= CAPTURE_LIMITS.maxEdgeDevicePx &&
    height * scale <= CAPTURE_LIMITS.maxEdgeDevicePx &&
    width * height * scale ** 2 <= CAPTURE_LIMITS.maxDevicePixels
  );
}
function assertCaptureFits(width, height, dpr, message) {
  if (!captureFits(width, height, dpr)) throw new Error(message);
}
// Largest CSS-pixel box that still fits the device-pixel budget at this ratio.
function captureBudget(dpr) {
  const scale = captureScale(dpr);
  return {
    maxEdge: Math.floor(CAPTURE_LIMITS.maxEdgeDevicePx / scale),
    maxArea: Math.floor(CAPTURE_LIMITS.maxDevicePixels / scale ** 2),
  };
}
async function readDevicePixelRatio(ctx) {
  const result = await ctx.send("Runtime.evaluate", {
    expression: "devicePixelRatio || 1",
    returnByValue: true,
  });
  return captureScale(result?.result?.value);
}

export { CAPTURE_LIMITS, captureFits, assertCaptureFits, captureBudget, readDevicePixelRatio };
