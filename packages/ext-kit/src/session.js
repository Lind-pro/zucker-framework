import { cancelled, throwIfAborted, withAbort, delay } from './util.js';
function debuggerAttach(target, version) {
  return new Promise((resolve, reject) =>
    chrome.debugger.attach(target, version, () => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve();
    }),
  );
}
function debuggerDetach(target) {
  return new Promise((resolve, reject) =>
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve();
    }),
  );
}
function sendCommand(target, method, params, signal) {
  throwIfAborted(signal);
  return withAbort(
    new Promise((resolve, reject) =>
      chrome.debugger.sendCommand(target, method, params || {}, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (result?.exceptionDetails)
          reject(new Error("Page script could not be evaluated"));
        else resolve(result || {});
      }),
    ),
    signal,
  );
}
async function waitForLoad(tabId, timeoutMs, signal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await delay(250, signal);
  }
  throw new Error("Page load timeout");
}
async function evaluatePage(target, fn, args, signal) {
  const result = await sendCommand(
    target,
    "Runtime.evaluate",
    {
      expression: `(${fn.toString()})(${JSON.stringify(args ?? null)})`,
      returnByValue: true,
    },
    signal,
  );
  return result.result?.value;
}
function watchNetwork(target) {
  const pending = new Set();
  let changedAt = Date.now();
  const listener = (source, method, params) => {
    if (source.tabId !== target.tabId) return;
    if (
      method === "Network.requestWillBeSent" &&
      ["Document", "XHR", "Fetch", "Stylesheet", "Font"].includes(params.type)
    ) {
      pending.add(params.requestId);
      changedAt = Date.now();
    } else if (
      ["Network.loadingFinished", "Network.loadingFailed"].includes(method) &&
      pending.delete(params.requestId)
    )
      changedAt = Date.now();
  };
  chrome.debugger.onEvent.addListener(listener);
  return {
    busy: () => pending.size > 0 || Date.now() - changedAt < 750,
    reset: () => {
      pending.clear();
      changedAt = Date.now();
    },
    dispose: () => chrome.debugger.onEvent.removeListener(listener),
  };
}
async function preparePageForCapture(target, signal) {
  await sendCommand(
    target,
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    signal,
  ).catch((error) => {
    throwIfAborted(signal);
  });
}
// This function runs inside the captured page. Do not depend on extension globals.
function pageMetrics({ maxSeenY = 0 } = {}) {
  function visible(el) {
    if (!el?.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (
      rect.width <= 2 ||
      rect.height <= 2 ||
      rect.top > maxSeenY + innerHeight
    )
      return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) < 0.05
      )
        return false;
    }
    return true;
  }
  const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const strong =
    '[aria-busy="true"],.ant-spin-spinning,.ant-skeleton,.mantine-Loader-root,.MuiCircularProgress-root,.v-progress-circular--indeterminate,.el-loading-mask,.chakra-spinner,[role="progressbar"]:not([aria-valuenow])';
  let loading = [...document.querySelectorAll(strong)].some(visible);
  if (!loading)
    loading = [
      ...document.querySelectorAll(".loading,.loader,.spinner,.skeleton"),
    ].some((el) => {
      if (!visible(el)) return false;
      const words = (el.innerText || "").trim();
      const rect = el.getBoundingClientRect();
      return (
        (words.length < 160 &&
          /^(loading\b|please wait\b|加载中|正在加载|読み込み中|로딩)/i.test(
            words,
          )) ||
        (!words &&
          rect.width <= 256 &&
          rect.height <= 256 &&
          getComputedStyle(el).animationName !== "none")
      );
    });
  const pendingImages = [...document.images].filter(
    (img) => !img.complete && visible(img) && img.width * img.height > 4000,
  ).length;
  const fontsPending = document.fonts?.status === "loading";
  let hash = 0;
  for (
    let i = 0;
    i < text.length;
    i += Math.max(1, Math.floor(text.length / 2000))
  )
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  const height = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement.scrollHeight,
  );
  return {
    complete: document.readyState === "complete",
    loading,
    pendingImages,
    fontsPending,
    signature: [
      location.href,
      text.length,
      hash,
      height,
      pendingImages,
      fontsPending,
    ].join("|"),
  };
}
async function waitForPageStable(
  target,
  options,
  signal,
  network,
  maxSeenY = 0,
) {
  const start = Date.now();
  let signature = "",
    stableSince = start,
    last;
  while (Date.now() - start < options.readyTimeoutMs) {
    throwIfAborted(signal);
    last = await evaluatePage(target, pageMetrics, { maxSeenY }, signal);
    if (!last) throw new Error("Could not inspect page readiness");
    if (
      last.signature !== signature ||
      !last.complete ||
      last.loading ||
      last.pendingImages ||
      last.fontsPending ||
      network?.busy()
    )
      stableSince = Date.now();
    signature = last.signature;
    if (Date.now() - stableSince >= 1000) return "";
    await delay(250, signal);
  }
  const reason = last?.loading
    ? "Page still shows loading UI"
    : "Page content is still changing or loading";
  if (options.allowUnstable)
    return `${reason}; captured after the readiness timeout at your request.`;
  throw new Error(
    `${reason}. Increase readiness wait, or choose Capture after timeout in Settings if this page is ready.`,
  );
}
function challengeError(name) {
  const error = new Error(`Blocked by ${name} verification`);
  error.isChallenge = true;
  return error;
}
function isChallengeError(error) {
  return Boolean(error?.isChallenge);
}
function pageProbe() {
  if (document.documentURI.startsWith("chrome-error://")) {
    // Chrome's error page shows the network error code; report it instead of
    // guessing, so a refused local dev server, a blocking extension and a DNS
    // failure can be told apart.
    const code =
      (document.body?.innerText.match(/\bERR_[A-Z0-9_]+/) || [])[0] || "";
    const hints = {
      ERR_CONNECTION_REFUSED:
        "nothing is accepting connections at this address; check that the server is running",
      ERR_BLOCKED_BY_CLIENT: "blocked by another browser extension",
      ERR_NAME_NOT_RESOLVED: "the host name could not be resolved",
      ERR_INTERNET_DISCONNECTED: "the computer is offline",
    };
    return {
      error: code
        ? `Page failed to load (${code}${hints[code] ? `: ${hints[code]}` : ""})`
        : "Page failed to load (network error)",
      challenge: "",
    };
  }
  const shown = (selector) =>
    [...document.querySelectorAll(selector)].some((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      );
    });
  const title = document.title.trim().toLowerCase();
  let challenge = "";
  // A tutorial mentioning CAPTCHA, or an ordinary form containing a captcha widget, is not a challenge page.
  if (
    shown("#challenge-form,#challenge-stage,#cf-challenge-running") &&
    /just a moment|checking your browser|attention required|verify/.test(
      title,
    )
  )
    challenge = "Cloudflare";
  else if (
    shown("#vercel-security-checkpoint,#challenge-container") &&
    /security checkpoint|verifying your browser|安全检查点/.test(title)
  )
    challenge = "Vercel";
  else if (
    /^(verify you are human|human verification|are you a robot|captcha|人机验证)[\s.!?—-]*$/i.test(
      title,
    ) &&
    shown(
      'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],input[name*="captcha"],[data-sitekey]',
    )
  )
    challenge = "bot-check";
  return { error: "", challenge };
}
async function probePage(target, signal) {
  return (
    (await evaluatePage(target, pageProbe, null, signal)) || {
      error: "",
      challenge: "",
    }
  );
}
async function waitForVerification(
  tabId,
  shouldStop,
  signal,
  timeoutMs = 180000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    if (shouldStop()) return false;
    await delay(2500, signal);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status !== "complete") continue;
    const target = { tabId };
    let attached = false;
    try {
      await debuggerAttach(target, "1.3");
      attached = true;
      const result = await probePage(target, signal);
      if (!result.challenge && !result.error) return true;
    } catch {
      throwIfAborted(signal);
    } finally {
      if (attached) await debuggerDetach(target).catch(() => {});
    }
  }
  return false;
}
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}
async function autoScroll(target, signal) {
  let maxSeenY = 0;
  for (let step = 0; step < 60; step++) {
    const position = await evaluatePage(
      target,
      () => {
        window.scrollBy({ top: 600, behavior: "instant" });
        return {
          y: scrollY,
          bottom:
            scrollY + innerHeight >=
            Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight || 0,
            ) -
              1,
        };
      },
      null,
      signal,
    );
    maxSeenY = Math.max(maxSeenY, position.y);
    await delay(120, signal);
    if (position.bottom) break;
  }
  await evaluatePage(
    target,
    () => window.scrollTo({ left: 0, top: 0, behavior: "instant" }),
    null,
    signal,
  );
  return maxSeenY;
}
async function getScrollPosition(target) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    returnByValue: true,
    expression: `({ x: window.scrollX || 0, y: window.scrollY || 0 })`,
  });
  const value = result.result?.value;
  return value || { x: 0, y: 0 };
}
// These two run inside the captured page and are self-contained on purpose:
// they are injected both through CDP evaluation and through chrome.scripting
// (the visible-window path attaches no debugger), so they must not reference
// extension scope. Keep them as the single definition of this save/restore pair.
function hidePageCaptureDecorations() {
  const hosts = [...document.querySelectorAll("browser-mcp-container")];
  window.__zuckerExtCaptureDecorations = hosts.map((el) => ({
    el,
    display: el.style.getPropertyValue("display"),
    priority: el.style.getPropertyPriority("display"),
  }));
  // Browser automation highlights/cursors belong to the browser, not the exported webpage.
  hosts.forEach((el) => el.style.setProperty("display", "none", "important"));
  return {
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio || 1,
  };
}
function showPageCaptureDecorations() {
  for (const saved of window.__zuckerExtCaptureDecorations || []) {
    if (saved.display)
      saved.el.style.setProperty("display", saved.display, saved.priority);
    else saved.el.style.removeProperty("display");
  }
  delete window.__zuckerExtCaptureDecorations;
}
function suppressCaptureDecorations(target, signal) {
  return sendCommand(
    target,
    "Runtime.evaluate",
    { expression: `(${hidePageCaptureDecorations.toString()})()` },
    signal,
  );
}
function restoreCaptureDecorations(target) {
  return sendCommand(target, "Runtime.evaluate", {
    expression: `(${showPageCaptureDecorations.toString()})()`,
  });
}
function restorePageAfterQuick(target, position) {
  const x = Number(position?.x) || 0;
  const y = Number(position?.y) || 0;
  return sendCommand(target, "Runtime.evaluate", {
    expression: `window.scrollTo({ left: ${x}, top: ${y}, behavior: "instant" })`,
  });
}

export { debuggerAttach, debuggerDetach, sendCommand, waitForLoad, watchNetwork, preparePageForCapture, waitForPageStable, challengeError, isChallengeError, probePage, waitForVerification, focusTab, autoScroll, getScrollPosition, hidePageCaptureDecorations, showPageCaptureDecorations, suppressCaptureDecorations, restoreCaptureDecorations, restorePageAfterQuick };
