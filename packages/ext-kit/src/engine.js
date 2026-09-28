import { throwIfAborted, withAbort, delay, normalizeError, storageCall, storageGet, storageSet, storageRemove } from './util.js';
import { normalizeUrls, todayString, folderNameFor, hostOf, buildQuickFileName, buildBatchFileName } from './naming';
import { createLicensing } from './licensing.js';
import { createDownloader } from './download.js';
import * as defaultScrollCapture from './scroll-capture.js';
import { debuggerAttach, debuggerDetach, sendCommand, waitForLoad, watchNetwork, preparePageForCapture, waitForPageStable, challengeError, isChallengeError, probePage, waitForVerification, focusTab, autoScroll, getScrollPosition, suppressCaptureDecorations, restoreCaptureDecorations, restorePageAfterQuick } from './session.js';
function initExtension(config) {
  if (!Number.isSafeInteger(config.freeDailyLimit) || config.freeDailyLimit < 0)
    throw new RangeError('freeDailyLimit must be an explicit non-negative integer');
  const normalizeSettings = (defaults, input) => {
    const settings = config.normalizeSettings
      ? config.normalizeSettings(defaults, input)
      : { ...defaults, ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}) };
    return {
      ...settings,
      delayMs: Math.min(10000, Math.max(0, Number(settings.delayMs) || 0)),
      readyTimeoutMs: Math.min(60000, Math.max(5000, Number(settings.readyTimeoutMs) || 25000)),
      allowUnstable: settings.allowUnstable === true,
      ignoreChallenge: settings.ignoreChallenge === true,
      expandScrollAreas: settings.expandScrollAreas !== false,
    };
  };
  const scrollCapture = config.scrollCapture || defaultScrollCapture;
  const texts = {
    alreadyRunning: "Another capture is already running",
    cannotQuick: "Open an http(s) website first.",
    challengeBeforeQuick: (name) =>
      `Complete the ${name} verification, or enable Capture verification page in Settings if this is a normal page.`,
    quickFolder: "Quick Captures",
    ...config.texts,
  };
  const prefix = config.messagePrefix;
  const BATCH_KEY = `${config.product}_batch_state`,
    QUICK_KEY = `${config.product}_quick_state`;
  const USAGE_KEY = `${config.product}_free_usage`,
    TAB_KEY = `${config.product}_owned_tab`;
  const licensing = createLicensing(
    config.product,
    config.brand,
    config.licensing,
  );
  const downloader = createDownloader(
    `Prepare local ${config.brand} downloads.`,
    config.downloads,
  );
  let activeRun = null;
  let batch = idleBatch();
  let restorePromise;
  function idleBatch() {
    return {
      version: 2,
      id: crypto.randomUUID(),
      running: false,
      cancelRequested: false,
      startedAt: null,
      folder: "",
      total: 0,
      done: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      current: "",
      freeLimited: false,
      needVerify: null,
      settings: normalizeSettings(config.defaultSettings),
      pro: false,
      items: [],
    };
  }
  function reserveRun(restoring = false) {
    if (activeRun || (!restoring && batch.running)) return null;
    activeRun = {
      controller: new AbortController(),
      job: null,
      skipVerify: false,
      windowId: null,
      idleTabId: null,
    };
    return activeRun;
  }
  function releaseRun(run) {
    if (activeRun === run) {
      activeRun = null;
      setBadge("");
    }
  }
  function recount(job) {
    job.success = job.items.filter((i) => i.status === "success").length;
    job.failed = job.items.filter((i) => i.status === "failed").length;
    job.cancelled = job.items.filter((i) => i.status === "cancelled").length;
    job.done = job.success + job.failed + job.cancelled;
  }
  function publicBatch() {
    return {
      ...batch,
      busy: Boolean(activeRun),
      // Marked running with no live controller: a final write failed and left
      // downloads unconfirmed. The popup must stay usable in this state.
      stalled: Boolean(batch.running && !activeRun),
      items: batch.items.map(
        ({ url, index, status, fileName, error, warning }) => ({
          url,
          index,
          status,
          fileName,
          error,
          warning,
        }),
      ),
    };
  }
  const persist = (job) => storageSet({ [BATCH_KEY]: job });
  function usageFrom(data) {
    const usage = data[USAGE_KEY];
    return usage?.date === todayString() &&
      Number.isSafeInteger(usage.used) &&
      usage.used >= 0
      ? usage.used
      : 0;
  }
  async function getQuota(cachedOnly = false, force = false) {
    const status = await licensing.getStatus({ cachedOnly, force });
    const license = {
      licenseStatus: status.state,
      licenseMessage: status.message || "",
      licenseRefreshing: Boolean(status.refreshing),
      hasLicense: status.state !== "free",
    };
    if (status.entitlement)
      return {
        ...license,
        pro: true,
        expiresAt: status.entitlement.expiresAt,
        limit: null,
        used: 0,
        remaining: null,
      };
    if (status.state !== "free")
      return {
        ...license,
        pro: false,
        limit: null,
        used: 0,
        remaining: null,
      };
    const used = usageFrom(await storageGet(USAGE_KEY));
    const limit = config.freeDailyLimit;
    return {
      ...license,
      pro: false,
      limit,
      used,
      remaining: Math.max(0, limit - used),
    };
  }
  function assertQuota(quota) {
    if (quota.pro) return;
    if (quota.hasLicense)
      throw new Error(
        quota.licenseMessage ||
          "Checking your Pro license. Use Recheck Pro in License and retry.",
      );
    if (!quota.remaining)
      throw new Error(
        `Daily free limit reached (${quota.limit} pages/day). Already purchased Pro? Enter your original activation code in License to restore unlimited exports.`,
      );
  }
  async function commitResult(job, item, status, error = "", quick = false) {
    const previous = {
      status: item.status,
      error: item.error,
      usageRecorded: item.usageRecorded,
    };
    let used;
    if (status === "success" && item.chargeFree && !item.usageRecorded) {
      used = usageFrom(await storageGet(USAGE_KEY)) + 1;
    }
    // A failed quota read must leave the download recoverable too, not just
    // failed writes. Do not expose a terminal status before that read succeeds.
    item.status = status;
    item.error = error;
    if (used !== undefined) item.usageRecorded = true;
    if (!quick) recount(job);
    // Persist the completion marker and free usage in the same storage write. Recovery cannot charge it twice.
    try {
      await storageSet({
        [quick ? QUICK_KEY : BATCH_KEY]: quick ? null : job,
        ...(used !== undefined
          ? { [USAGE_KEY]: { date: todayString(), used } }
          : {}),
      });
    } catch (error) {
      Object.assign(item, previous);
      if (!quick) recount(job);
      throw error;
    }
  }
  function makeItem(url, index) {
    return {
      url,
      index,
      status: "pending",
      fileName: "",
      error: "",
      warning: "",
      usageRecorded: false,
    };
  }
  async function recoverQuick(signal) {
    const quick = (await storageGet(QUICK_KEY))[QUICK_KEY];
    if (!quick) return;
    if (quick.downloadId == null && !quick.downloadUrl) {
      await storageRemove(QUICK_KEY);
      return;
    }
    let recovered = false;
    try {
      await downloader.recover(quick, signal);
      recovered = true;
    } catch {
      await storageRemove(QUICK_KEY);
    }
    // A failed completion write must remain recoverable before any new request
    // can replace the quick-capture checkpoint.
    if (recovered) await commitResult(null, quick, "success", "", true);
  }
  async function startBatch(urls, settings) {
    const run = reserveRun();
    if (!run) return { ok: false, error: texts.alreadyRunning };
    try {
      await recoverQuick(run.controller.signal);
      const normalized = normalizeUrls(urls);
      if (!normalized.length) throw new Error("No valid http(s) URLs");
      const quota = await withAbort(getQuota(), run.controller.signal);
      throwIfAborted(run.controller.signal);
      assertQuota(quota);
      const accepted = quota.pro
        ? normalized
        : normalized.slice(0, quota.remaining);
      batch = {
        ...idleBatch(),
        running: true,
        startedAt: Date.now(),
        folder: `${config.brand}/${folderNameFor(accepted)}-${crypto.randomUUID().slice(0, 6)}`,
        total: accepted.length,
        freeLimited: accepted.length < normalized.length,
        settings: normalizeSettings(config.defaultSettings, settings),
        pro: quota.pro,
        items: accepted.map((url, index) => makeItem(url, index + 1)),
      };
      run.job = batch;
      await persist(batch);
      void runBatch(batch, run);
      return { ok: true, batch: publicBatch(), quota };
    } catch (error) {
      releaseRun(run);
      throw error;
    }
  }
  async function runBatch(job, run, { keepLock = false } = {}) {
    const signal = run.controller.signal;
    const lastHostAt = new Map();
    try {
      for (const item of job.items) {
        if (["success", "failed", "cancelled"].includes(item.status))
          continue;
        // Reconcile an already-created download even when the saved batch was stopped.
        if (item.downloadId != null || item.downloadUrl) {
          let error;
          try {
            await downloader.recover(item, signal);
          } catch (failure) {
            error = failure;
          }
          await commitResult(
            job,
            item,
            error
              ? signal.aborted || error.message === "Cancelled"
                ? "cancelled"
                : "failed"
              : "success",
            error ? normalizeError(error) : "",
          );
          continue;
        }
        throwIfAborted(signal);
        const quota = await withAbort(getQuota(), signal);
        assertQuota(quota);
        const host = hostOf(item.url),
          previous = lastHostAt.get(host) || 0;
        await delay(Math.max(0, (config.sameHostGapMs ?? 1800) - (Date.now() - previous)), signal);
        lastHostAt.set(host, Date.now());
        item.chargeFree = !quota.pro;
        item.status = "running";
        job.current = item.url;
        setBadge(`${job.done + 1}/${job.total}`);
        await persist(job);
        let error;
        try {
          await captureUrl(item, job, run);
        } catch (failure) {
          error = failure;
        }
        await commitResult(
          job,
          item,
          error
            ? signal.aborted || error.message === "Cancelled"
              ? "cancelled"
              : "failed"
            : "success",
          error ? normalizeError(error) : "",
        );
      }
    } catch (error) {
      const message = normalizeError(error);
      job.current = message;
      // Quota exhaustion or a storage failure aborts the loop. Without this the
      // untouched rows sit at "pending" forever with no reason shown anywhere.
      if (!signal.aborted && !job.cancelRequested)
        for (const item of job.items)
          if (item.status === "pending") {
            item.status = "failed";
            item.error = message;
          }
    } finally {
      if (signal.aborted || job.cancelRequested) {
        job.cancelRequested = true;
        for (const item of job.items)
          if (["pending", "running"].includes(item.status))
            item.status = "cancelled";
        job.current = "Stopped";
      } else if (
        job.items.every((i) =>
          ["success", "failed", "cancelled"].includes(i.status),
        )
      )
        job.current = "Done";
      job.running = job.items.some((item) => item.status === "downloading");
      if (job.running)
        job.current =
          "Some downloads could not be confirmed. Press Stop to reconcile them.";
      job.needVerify = null;
      recount(job);
      try {
        await persist(job);
      } catch {
        console.warn(`${config.brand}: could not save final task state`);
      }
      try {
        await closeBatchWindow(run);
      } finally {
        if (!keepLock) releaseRun(run);
      }
    }
  }
  async function quickCapture(tabId, settings) {
    const run = reserveRun();
    if (!run) return { ok: false, error: texts.alreadyRunning };
    const signal = run.controller.signal;
    try {
      await recoverQuick(signal);
      if (!Number.isInteger(tabId)) throw new Error("No active web page");
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:\/\//i.test(tab?.url || ""))
        throw new Error(texts.cannotQuick);
      const quota = await withAbort(getQuota(), signal);
      assertQuota(quota);
      const item = { ...makeItem(tab.url, 1), chargeFree: !quota.pro };
      const options = normalizeSettings(config.defaultSettings, settings);
      await storageSet({ [QUICK_KEY]: item });
      const visibleOutput = await config.captureQuick?.({
        tab,
        options,
        signal,
      });
      if (visibleOutput)
        return await deliverQuick(item, visibleOutput, signal);
      const target = { tabId };
      let attached = false,
        position = null;
      const network = watchNetwork(target);
      const ctx = makeContext(
        "quick",
        tabId,
        item.url,
        options,
        target,
        signal,
      );
      try {
        await debuggerAttach(target, "1.3");
        attached = true;
        if ((config.captureScope?.(options) || "full") === "full")
          position = await getScrollPosition(target);
        await config.beforeQuick?.(ctx, tab);
        await sendCommand(target, "Network.enable", {}, signal);
        if ((config.captureScope?.(options) || "full") === "full") {
          await preparePageForCapture(target, signal);
        }
        await suppressCaptureDecorations(target, signal);
        await prepareCapture(target, item, options, run, network, "quick");
        const output = await capturePrepared(ctx, options, run, network);
        throwIfAborted(signal);
        return await deliverQuick(item, output, signal);
      } finally {
        network.dispose();
        if (attached) {
          await config.afterQuick?.(ctx).catch(() => {});
          await restoreCaptureDecorations(target).catch(() => {});
          if (position && (await isCurrentQuickPage(ctx)))
            await restorePageAfterQuick(target, position).catch(() => {});
          await debuggerDetach(target).catch(() => {});
        }
      }
    } catch (error) {
      // Keep a download checkpoint for recovery when a storage operation failed after file creation.
      const saved = (await storageGet(QUICK_KEY))[QUICK_KEY];
      if (!saved?.downloadId && !saved?.downloadUrl)
        await storageRemove(QUICK_KEY);
      return {
        ok: false,
        error: normalizeError(error),
        quota: await getQuota(true),
      };
    } finally {
      releaseRun(run);
    }
  }
  async function deliverQuick(item, output, signal) {
    throwIfAborted(signal);
    item.warning = [item.warning, output.warning].filter(Boolean).join(" ");
    item.fileName = buildQuickFileName(
      config.brand,
      texts.quickFolder,
      item.url,
      output.extension,
    );
    await saveOutput(item, output, signal, () =>
      storageSet({ [QUICK_KEY]: item }),
    );
    await commitResult(null, item, "success", "", true);
    return {
      ok: true,
      result: { fileName: item.fileName, warning: item.warning },
      quota: await getQuota(true),
    };
  }
  async function isCurrentQuickPage(ctx) {
    if (ctx.mode !== "quick") return true;
    try {
      const current = await chrome.tabs.get(ctx.tabId);
      return (
        current.url === ctx.url &&
        (!current.pendingUrl || current.pendingUrl === ctx.url)
      );
    } catch {
      return false;
    }
  }
  async function assertCurrentQuickPage(ctx) {
    if (!(await isCurrentQuickPage(ctx)))
      throw new Error(
        "The page changed during capture. Return to the requested page and try again.",
      );
  }
  async function capturePrepared(ctx, options, run, network) {
    const expand =
      (config.captureScope?.(options) || "full") === "full" &&
      options.expandScrollAreas;
    try {
      await assertCurrentQuickPage(ctx);
      const warnings = new Set();
      if (expand)
        await scrollCapture?.prepare(ctx, async () => {
          await assertCurrentQuickPage(ctx);
          const warning = await waitForPageStable(
            { tabId: ctx.tabId },
            options,
            run.controller.signal,
            network,
          );
          if (warning) warnings.add(warning);
        });
      await assertCurrentQuickPage(ctx);
      const output = await config.capture(ctx);
      await assertCurrentQuickPage(ctx);
      if (output.warning) warnings.add(output.warning);
      return { ...output, warning: [...warnings].join(" ") };
    } finally {
      if (expand) await scrollCapture?.restore(ctx);
    }
  }
  async function prepareCapture(
    target,
    item,
    options,
    run,
    network,
    mode = "batch",
  ) {
    const signal = run.controller.signal;
    const probe = await probePage(target, signal);
    if (probe.error) throw new Error(probe.error);
    if (probe.challenge && !options.ignoreChallenge)
      throw challengeError(probe.challenge);
    if (probe.challenge)
      item.warning = `Captured a ${probe.challenge} verification page at your request.`;
    const scope = config.captureScope?.(options) || "full";
    // Visible-window export records the current view; scrolling or waiting for
    // another application state would violate that contract.
    if (scope === "viewport" && mode === "quick") return;
    await delay(options.delayMs, signal);
    const before = await waitForPageStable(target, options, signal, network);
    const maxSeenY = scope === "full" ? await autoScroll(target, signal) : 0;
    // Scrolling triggers page-owned reveal behavior. Never force hidden UI visible.
    const after = await waitForPageStable(
      target,
      options,
      signal,
      network,
      maxSeenY,
    );
    item.warning = [
      ...new Set([item.warning, before, after].filter(Boolean)),
    ].join(" ");
  }
  async function saveOutput(item, output, signal, save) {
    throwIfAborted(signal);
    await downloader.downloadViaBlob(
      output.base64,
      output.mime,
      item.fileName,
      {
        signal,
        onPrepared: async (url) => {
          item.downloadUrl = url;
          item.status = "downloading";
          await save();
        },
        onCreated: async (id) => {
          item.downloadId = id;
          await save();
        },
      },
    );
  }
  async function captureUrl(item, job, run) {
    const signal = run.controller.signal;
    for (let attempt = 0; attempt <= 3; attempt++) {
      throwIfAborted(signal);
      try {
        return await captureOnce(item, job, run, attempt === 3);
      } catch (error) {
        if (!isChallengeError(error) || attempt === 3) throw error;
        job.current = "Waiting before retrying verification…";
        await persist(job);
        await delay(8000 * (attempt + 1), signal);
      }
    }
  }
  // Batch pages load in a window of their own so that a 500-URL run does not
  // churn the tab strip the user is working in. It is created unfocused but
  // deliberately NOT minimized: Page.captureScreenshot with fromSurface needs a
  // live compositing surface, which a minimized window does not reliably have.
  // The window keeps one idle about:blank tab so it survives between captures.
  async function ensureBatchWindow(run) {
    if (Number.isInteger(run.windowId)) {
      const live = await chrome.windows.get(run.windowId).catch(() => null);
      if (live) return run.windowId;
      run.windowId = null;
      run.idleTabId = null;
    }
    const created = await chrome.windows
      .create({ url: "about:blank", focused: false })
      .catch(() => null);
    // Falling back to the current window is better than failing the batch.
    run.windowId = Number.isInteger(created?.id) ? created.id : null;
    run.idleTabId = created?.tabs?.[0]?.id ?? null;
    await saveTabLease(run);
    return run.windowId;
  }
  function saveTabLease(run, tabId = null) {
    return storageCall("session", "set", {
      [TAB_KEY]: {
        tabId,
        jobId: run.job?.id,
        windowId: run.windowId,
        idleTabId: run.idleTabId,
      },
    });
  }
  async function closeIdleTab(lease) {
    if (!Number.isInteger(lease?.idleTabId)) return;
    const tab = await chrome.tabs.get(lease.idleTabId).catch(() => null);
    // The user can add/move tabs into this window or navigate our idle tab.
    // Removing only our untouched idle tab lets Chrome close an empty window
    // atomically, without racing a new user tab against windows.remove().
    if (
      tab?.windowId === lease.windowId &&
      tab.url === "about:blank" &&
      (!tab.pendingUrl || tab.pendingUrl === "about:blank")
    )
      await chrome.tabs.remove(tab.id).catch(() => {});
  }
  async function closeBatchWindow(run) {
    await closeIdleTab(run);
    run.windowId = null;
    run.idleTabId = null;
    await storageCall("session", "remove", TAB_KEY).catch(() => {});
  }
  async function captureOnce(item, job, run, interactive) {
    const signal = run.controller.signal,
      options = job.settings;
    // Attach before navigation so in-flight SPA requests are observable from the beginning.
    const windowId = await ensureBatchWindow(run);
    const tab = await chrome.tabs.create({
      url: "about:blank",
      active: interactive,
      ...(Number.isInteger(windowId) ? { windowId } : {}),
    });
    const tabId = tab.id,
      target = { tabId };
    let attached = false;
    const network = watchNetwork(target);
    try {
      await saveTabLease(run, tabId);
      throwIfAborted(signal);
      await debuggerAttach(target, "1.3");
      attached = true;
      await sendCommand(target, "Page.enable", {}, signal);
      await sendCommand(target, "Network.enable", {}, signal);
      const ctx = makeContext(
        "batch",
        tabId,
        item.url,
        options,
        target,
        signal,
      );
      if (config.beforeScroll) await config.beforeScroll(ctx);
      await preparePageForCapture(target, signal);
      await chrome.tabs.update(tabId, { url: item.url });
      await waitForLoad(tabId, 30000, signal);
      await suppressCaptureDecorations(target, signal);
      const probe = await probePage(target, signal);
      if (probe.challenge && !options.ignoreChallenge && interactive) {
        await debuggerDetach(target);
        attached = false;
        await focusTab(tabId);
        job.needVerify = { url: item.url, challenge: probe.challenge };
        job.current = `Complete ${probe.challenge} verification in the opened tab…`;
        run.skipVerify = false;
        await persist(job);
        const passed = await waitForVerification(
          tabId,
          () => run.skipVerify,
          signal,
        );
        job.needVerify = null;
        job.current = item.url;
        await persist(job);
        if (!passed)
          throw challengeError(
            `${probe.challenge} verification not completed`,
          );
        await debuggerAttach(target, "1.3");
        attached = true;
        network.reset();
        await sendCommand(target, "Network.enable", {}, signal);
        await preparePageForCapture(target, signal);
      }
      await prepareCapture(target, item, options, run, network);
      const output = await capturePrepared(ctx, options, run, network);
      throwIfAborted(signal);
      item.warning = [item.warning, output.warning].filter(Boolean).join(" ");
      item.fileName = buildBatchFileName(job.folder, item, output.extension);
      await saveOutput(item, output, signal, () => persist(job));
    } finally {
      network.dispose();
      if (attached) {
        await restoreCaptureDecorations(target).catch(() => {});
        await debuggerDetach(target).catch(() => {});
      }
      await chrome.tabs.remove(tabId).catch(() => {});
      // Retain the idle-tab lease between captures and verification retries.
      await saveTabLease(run);
    }
  }
  function makeContext(mode, tabId, url, options, target, signal) {
    return {
      mode,
      tabId,
      url,
      options,
      send: (method, params) => sendCommand(target, method, params, signal),
      cleanup: (method, params) => sendCommand(target, method, params),
    };
  }
  async function restoreBatch() {
    const data = await storageGet([BATCH_KEY, QUICK_KEY]);
    // Session storage survives a worker restart but not a browser restart; never close a reused tab ID from an older browser session.
    const lease = (await storageCall("session", "get", TAB_KEY))[TAB_KEY];
    if (Number.isInteger(lease?.tabId) || Number.isInteger(lease?.windowId)) {
      if (Number.isInteger(lease.tabId))
        await chrome.tabs.remove(lease.tabId).catch(() => {});
      await closeIdleTab(lease);
      await storageCall("session", "remove", TAB_KEY);
    }
    await recoverQuick();
    const saved = data[BATCH_KEY];
    if (!Array.isArray(saved?.items) || !saved.items.length) return;
    const items = saved.items
      .filter(
        (item) =>
          typeof item?.url === "string" && normalizeUrls([item.url]).length,
      )
      .slice(0, 500);
    batch = {
      ...idleBatch(),
      ...saved,
      version: 2,
      settings: normalizeSettings(
        config.defaultSettings,
        config.migrateSettings
          ? config.migrateSettings(saved.settings)
          : saved.settings,
      ),
      needVerify: null,
      items: items.map((item, i) => ({
        ...makeItem(item.url, i + 1),
        ...item,
        chargeFree: item.chargeFree ?? !saved.pro,
        status: ["success", "failed", "cancelled", "downloading"].includes(
          item.status,
        )
          ? item.status
          : "pending",
      })),
    };
    batch.total = batch.items.length;
    if (!batch.folder)
      batch.folder = `${config.brand}/${folderNameFor(batch.items.map((i) => i.url))}`;
    recount(batch);
    if (saved.running) {
      const run = reserveRun(true);
      run.job = batch;
      if (saved.cancelRequested) run.controller.abort();
      batch.current = saved.cancelRequested
        ? "Stopping…"
        : "Resuming interrupted batch…";
      await persist(batch);
      void runBatch(batch, run);
    }
  }
  async function handleMessage(message) {
    await restorePromise;
    switch (message?.type) {
      case `${prefix}_START`:
        return startBatch(message.urls, message.settings);
      case `${prefix}_CAPTURE_CURRENT`:
      case `${prefix}_CONVERT_CURRENT`:
        return quickCapture(message.tabId, message.settings);
      case `${prefix}_CANCEL`:
        if (activeRun) {
          activeRun.controller.abort();
          if (activeRun.job) {
            activeRun.job.cancelRequested = true;
            activeRun.job.current = "Stopping…";
            await persist(activeRun.job);
          }
        } else if (batch.running) {
          // Stalled: running with no controller. Take the batch over in an
          // already-cancelled run so the recovery path confirms or cancels the
          // unfinished downloads and the rest is marked cancelled.
          const run = reserveRun(true);
          if (run) {
            run.job = batch;
            batch.cancelRequested = true;
            batch.current = "Stopping…";
            run.controller.abort();
            await persist(batch).catch(() => {});
            void runBatch(batch, run);
          }
        }
        return { ok: true, batch: publicBatch() };
      case `${prefix}_CLEAR_BATCH`: {
        const run = reserveRun(true);
        if (!run)
          return {
            ok: false,
            error: "Stop the running task before clearing it",
          };
        try {
          // Keep the capture lock through reconciliation AND deletion. A
          // concurrent Start/Clear must not replace an uncharged checkpoint.
          run.job = batch;
          if (
            batch.running ||
            batch.items.some((item) => item.status === "downloading")
          ) {
            batch.cancelRequested = true;
            run.controller.abort();
            await runBatch(batch, run, { keepLock: true });
            if (batch.running)
              throw new Error(
                "Downloads could not be confirmed. Results were kept; retry Stop or Clear.",
              );
          }
          await storageRemove(BATCH_KEY);
          batch = idleBatch();
        } finally {
          releaseRun(run);
        }
        return {
          ok: true,
          batch: publicBatch(),
          quota: await getQuota(true),
        };
      }
      case `${prefix}_SKIP_VERIFY`:
        if (activeRun) activeRun.skipVerify = true;
        return { ok: true };
      case `${prefix}_STATE`:
        return {
          ok: true,
          batch: publicBatch(),
          quota: await getQuota(true),
        };
      case `${prefix}_ACTIVATE`:
        await licensing.activate(message.code);
        return { ok: true, quota: await getQuota(true) };
      case `${prefix}_REFRESH_LICENSE`:
        return { ok: true, quota: await getQuota(false, true) };
      case `${prefix}_CLEAR_LICENSE`:
        await licensing.deactivate();
        return { ok: true, quota: await getQuota(true) };
      default:
        return { ok: false, error: "Unknown message" };
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.target === "offscreen" ||
      (sender.id && sender.id !== chrome.runtime.id)
    )
      return false;
    handleMessage(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: normalizeError(error) }),
      );
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => {
    // Install and upgrade both use the normal versioned restore path; neither clears a live task.
    void restorePromise.catch(() => {});
  });
  function setBadge(text) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: config.badgeColor });
  }
  restorePromise = restoreBatch();
}

export { initExtension };
