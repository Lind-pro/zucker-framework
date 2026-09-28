// __EXT_BRAND__ 业务层：批处理/节流/挑战接力/下载/授权等基建全部由 lib/ext-kit.js 提供
// （产物来自 zucker-framework packages/ext-kit，用 `zucker ext sync` 更新）。
importScripts("lib/ext-kit.js", "lib/scroll-capture.js");

const MAX_CAPTURE_HEIGHT = 16000;

ZuckerExt.init({
  product: "__EXT_SLUG__",
  brand: "__EXT_BRAND__",
  messagePrefix: "__EXT_PREFIX__",
  badgeColor: "__EXT_BADGE_COLOR__",
  freeDailyLimit: 30,
  defaultSettings: {
    format: "png",
    quality: 90,
    viewportWidth: 1280,
    delayMs: 1500
  },
  licensing: {
    // The template owns endpoint, envelope, entitlement and timing policy.
    purchaseUrl: "https://example.invalid/__EXT_SLUG__",
    cacheTtlMs: 12 * 60 * 60 * 1000,
    offlineGraceMs: 72 * 60 * 60 * 1000,
    requestTimeoutMs: 5000,
    retryDelayMs: 60 * 1000,
    normalizeEntitlement(value) {
      return value && value.active !== false && value.plan === "pro"
        && typeof value.expiresAt === "string" ? value : null;
    },
    async request(operation, input, signal) {
      const activating = operation === "activate";
      const response = await fetch(`https://api.example.invalid/extension/licenses/${operation}`, {
        method: operation === "me" ? "GET" : "POST",
        signal,
        headers: activating
          ? { "Content-Type": "application/json" }
          : { Authorization: `Bearer ${input.token}` },
        ...(activating ? { body: JSON.stringify({
          code: String(input.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
          deviceId: input.deviceId,
          deviceName: `${input.brand} · Chrome`,
        }) } : {}),
      });
      const payload = await response.json().catch(() => null);
      const data = payload?.result ?? payload;
      // A proxy HTML 403 is not an authoritative license rejection.
      const denied = [401, 403].includes(response.status)
        && (payload?.status === response.status || payload?.statusCode === response.status)
        && typeof payload?.message === "string";
      return {
        accepted: response.ok && data != null,
        denied,
        token: data?.token,
        entitlement: activating ? data?.entitlement : data,
        deactivated: data?.deactivated === true,
      };
    }
  },
  scrollCapture: ZuckerScrollCapture,
  // 批量模式先固定视口宽度以保证一致排版（quick 模式不动用户的 tab，不会调用）
  async beforeScroll(ctx) {
    await ctx.send("Emulation.setDeviceMetricsOverride", {
      width: Number(ctx.options.viewportWidth) || 1280,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false
    });
  },
  // 核心业务：页面已加载、已过验证、已滚动揭示，产出整页截图
  async capture(ctx) {
    const metrics = await ctx.send("Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize;
    const width = Math.min(Math.ceil(content.width), 4000);
    const fullHeight = Math.ceil(content.height);
    const height = Math.min(fullHeight, MAX_CAPTURE_HEIGHT);
    const format = ctx.options.format === "jpeg" ? "jpeg" : "png";
    const quality = Math.min(Math.max(Number(ctx.options.quality) || 90, 30), 100);
    const shot = await ctx.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality } : {}),
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });
    return {
      base64: shot.data,
      mime: `image/${format}`,
      extension: format === "jpeg" ? "jpg" : "png",
      warning: fullHeight > MAX_CAPTURE_HEIGHT
        ? `Page height ${fullHeight}px exceeded the ${MAX_CAPTURE_HEIGHT}px capture limit; image was truncated.`
        : ""
    };
  }
});
