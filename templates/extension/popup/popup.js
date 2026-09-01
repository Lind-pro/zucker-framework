// __EXT_BRAND__ popup 业务层：队列/进度/授权 UI 全部由 lib/ext-kit-popup.js 驱动，
// 这里只声明设置字段与文案。
ZuckerExtPopup.init({
  messagePrefix: "__EXT_PREFIX__",
  queueKey: "__EXT_SLUG___url_queue",
  quickType: "CAPTURE_CURRENT",
  texts: {
    startNone: "Capture selected",
    startSome: (n) => `Capture ${n} page${n === 1 ? "" : "s"}`,
    quickIng: "Capturing current page…",
    quickFailed: "Capture failed"
  },
  collectSettings: () => ({
    format: document.getElementById("format").value,
    viewportWidth: Number(document.getElementById("viewportWidth").value),
    delayMs: Number(document.getElementById("delayMs").value)
  }),
  collectQuickSettings: () => ({
    format: document.getElementById("format").value,
    delayMs: Number(document.getElementById("delayMs").value)
  }),
  quickResult: (result) => {
    const warning = result.warning ? " — page was truncated at 16,000px" : "";
    return `Saved to Downloads/${result.fileName}${warning}`;
  }
});
