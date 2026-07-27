import type { CaptureContext, CaptureOutput, ExtKitConfig, ExtTexts, Settings } from './types';
import { clamp, delay, normalizeError, storageGet, storageRemove, storageSet } from './util';
import {
  buildBatchFileName,
  buildQuickFileName,
  folderNameFor,
  hostOf,
  normalizeUrls,
  todayString,
} from './naming';
import { createLicensing } from './licensing';
import { createDownloader } from './download';
import {
  autoScroll,
  challengeError,
  debuggerAttach,
  debuggerDetach,
  focusTab,
  getScrollPosition,
  isChallengeError,
  probePage,
  restorePageAfterQuick,
  revealAnimations,
  sendCommand,
  waitForLoad,
  waitForVerification,
  type DebuggerTarget,
} from './session';

const LOAD_TIMEOUT_MS = 30000;
// 同域名相邻请求的最小间隔：批量快速访问同一站点会触发其速率风控，节流降低触发概率
const SAME_HOST_MIN_GAP_MS = 1800;

interface BatchItem {
  url: string;
  index: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  fileName: string;
  error: string;
  warning: string;
  usageRecorded: boolean;
}

interface BatchState {
  running: boolean;
  cancelRequested: boolean;
  startedAt: number | null;
  folder: string;
  total: number;
  done: number;
  success: number;
  failed: number;
  current: string;
  freeLimited: boolean;
  needVerify: { url: string; challenge: string } | null;
  skipVerify: boolean;
  settings: Settings;
  pro: boolean;
  items: BatchItem[];
}

const DEFAULT_TEXTS: ExtTexts = {
  alreadyRunning: 'Another capture is already running',
  cannotQuick: 'This page cannot be captured. Open an http(s) website first.',
  challengeBeforeQuick: (challenge) => `Complete the ${challenge} verification before capturing this page.`,
  quickFolder: 'Quick Captures',
};

export function initExtension(config: ExtKitConfig): void {
  const texts: ExtTexts = { ...DEFAULT_TEXTS, ...(config.texts || {}) };
  const freeDailyLimit = config.freeDailyLimit ?? 30;
  const USAGE_KEY = `${config.product}_free_usage`;
  const BATCH_KEY = `${config.product}_batch_state`;
  const prefix = config.messagePrefix;

  const licensing = createLicensing(config.product, config.brand, config.licensing);
  const downloader = createDownloader(
    `Convert large ${config.brand} output into a downloadable blob URL.`,
  );

  let batch = idleBatch();
  let restorePromise = restoreBatch();
  let quickRunning = false;

  // Reloading/updating the extension is an explicit reset. Normal MV3 worker suspension does
  // not fire this event, so interrupted batches still resume during ordinary browser use.
  chrome.runtime.onInstalled.addListener(() => {
    const previousRestore = restorePromise;
    restorePromise = (async () => {
      await previousRestore.catch(() => {});
      batch = idleBatch();
      await storageRemove(BATCH_KEY);
      setBadge('');
    })();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // 发给 offscreen document 的消息由它自己处理，SW 不抢答
    if ((message as { target?: string })?.target === 'offscreen') {
      return false;
    }
    handleMessage(message as { type: string } & Record<string, unknown>)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  });

  function idleBatch(): BatchState {
    return {
      running: false,
      cancelRequested: false,
      startedAt: null,
      folder: '',
      total: 0,
      done: 0,
      success: 0,
      failed: 0,
      current: '',
      freeLimited: false,
      needVerify: null,
      skipVerify: false,
      settings: { ...config.defaultSettings },
      pro: false,
      items: [],
    };
  }

  async function handleMessage(message: { type: string } & Record<string, unknown>) {
    await restorePromise;
    switch (message.type) {
      case `${prefix}_START`:
        return startBatch(message.urls as unknown[], message.settings as Settings);
      // 两个后缀都接受：CAPTURE_CURRENT（截图类）/ CONVERT_CURRENT（转换类），兼容既有 popup
      case `${prefix}_CAPTURE_CURRENT`:
      case `${prefix}_CONVERT_CURRENT`:
        return quickCapture(message.tabId as number, message.settings as Settings);
      case `${prefix}_CANCEL`:
        return cancelBatch();
      case `${prefix}_CLEAR_BATCH`:
        return clearBatch();
      case `${prefix}_SKIP_VERIFY`:
        batch.skipVerify = true;
        await persistBatch();
        return { ok: true };
      case `${prefix}_STATE`:
        return { ok: true, batch: publicBatch(), quota: await getQuota() };
      case `${prefix}_ACTIVATE`:
        await licensing.activate(message.code as string);
        return { ok: true, quota: await getQuota() };
      case `${prefix}_CLEAR_LICENSE`:
        await licensing.clear();
        return { ok: true, quota: await getQuota() };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  }

  async function getQuota() {
    const entitlement = await licensing.getEntitlement().catch(() => null);
    if (entitlement) {
      // chrome 消息走 JSON 序列化，Infinity 会变 null，用大数表示不限量
      return { pro: true, expiresAt: entitlement.expiresAt, limit: null, used: 0, remaining: 999999 };
    }
    const data = await storageGet(USAGE_KEY);
    const usage = data[USAGE_KEY] as { date?: string; used?: number } | undefined;
    const today = todayString();
    const used = usage && usage.date === today ? usage.used || 0 : 0;
    return { pro: false, limit: freeDailyLimit, used, remaining: Math.max(0, freeDailyLimit - used) };
  }

  async function recordUsage(count: number) {
    const data = await storageGet(USAGE_KEY);
    const today = todayString();
    const usage = data[USAGE_KEY] as { date?: string; used?: number } | undefined;
    const used = usage && usage.date === today ? usage.used || 0 : 0;
    await storageSet({ [USAGE_KEY]: { date: today, used: used + count } });
  }

  async function startBatch(urls: unknown[], settings: Settings) {
    if (batch.running || quickRunning) {
      return { ok: false, error: texts.alreadyRunning };
    }

    const normalized = normalizeUrls(urls);
    if (!normalized.length) {
      return { ok: false, error: 'No valid http(s) URLs' };
    }

    const quota = await getQuota();
    if (!quota.pro && quota.remaining <= 0) {
      return {
        ok: false,
        error: `Daily free limit reached (${quota.limit} pages/day). Go Pro for unlimited pages.`,
      };
    }

    const freeLimited = !quota.pro && normalized.length > quota.remaining;
    const accepted = quota.pro ? normalized : normalized.slice(0, quota.remaining);
    const options = { ...config.defaultSettings, ...(settings || {}) };

    batch = {
      ...idleBatch(),
      running: true,
      startedAt: Date.now(),
      folder: `${config.brand}/${folderNameFor(accepted)}`,
      total: accepted.length,
      freeLimited,
      settings: options,
      pro: quota.pro,
      items: accepted.map((url, index) => ({
        url,
        index: index + 1,
        status: 'pending' as const,
        fileName: '',
        error: '',
        warning: '',
        usageRecorded: false,
      })),
    };

    await persistBatch();

    runBatch(options).catch((error) => {
      batch.running = false;
      batch.current = normalizeError(error);
      persistBatch();
    });

    return { ok: true, batch: publicBatch(), quota: await getQuota() };
  }

  async function quickCapture(tabId: number, settings: Settings) {
    if (batch.running || quickRunning) {
      return { ok: false, error: texts.alreadyRunning };
    }
    if (!Number.isInteger(tabId)) {
      return { ok: false, error: 'No active web page' };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
      return { ok: false, error: texts.cannotQuick };
    }

    const quota = await getQuota();
    if (!quota.pro && quota.remaining <= 0) {
      return {
        ok: false,
        error: `Daily free limit reached (${quota.limit} pages/day). Go Pro for unlimited pages.`,
      };
    }

    quickRunning = true;
    setBadge('1');
    try {
      const options = { ...config.defaultSettings, ...(settings || {}) };
      const result = await captureExistingTab(tabId, tab.url, options);
      if (!quota.pro) {
        await recordUsage(1);
      }
      setBadge('OK');
      setTimeout(() => setBadge(''), 4000);
      return { ok: true, result, quota: await getQuota() };
    } catch (error) {
      setBadge('ERR');
      setTimeout(() => setBadge(''), 4000);
      return { ok: false, error: normalizeError(error), quota: await getQuota() };
    } finally {
      quickRunning = false;
    }
  }

  async function captureExistingTab(tabId: number, pageUrl: string, options: Settings) {
    const target: DebuggerTarget = { tabId };
    let attached = false;
    let scrollPosition = { x: 0, y: 0 };
    try {
      await debuggerAttach(target, '1.3');
      attached = true;
      await sendCommand(target, 'Page.enable');
      await sendCommand(target, 'Runtime.enable');

      const probe = await probePage(target);
      if (probe.error) {
        throw new Error(probe.error);
      }
      if (probe.challenge) {
        throw new Error(texts.challengeBeforeQuick(probe.challenge));
      }

      scrollPosition = await getScrollPosition(target);
      await delay(clamp(Number(options.delayMs) || Number(config.defaultSettings.delayMs) || 1500, 0, 10000));
      await autoScroll(target);
      await revealAnimations(target, true);
      await delay(400);

      const output = await config.capture(makeContext('quick', tabId, pageUrl, options, target));
      const fileName = buildQuickFileName(config.brand, texts.quickFolder, pageUrl, output.extension);
      await downloader.downloadViaBlob(output.base64, output.mime, fileName);
      return { fileName, warning: output.warning || '' };
    } finally {
      if (attached) {
        await restorePageAfterQuick(target, scrollPosition).catch(() => {});
        await debuggerDetach(target).catch(() => {});
      }
    }
  }

  async function cancelBatch() {
    if (batch.running) {
      batch.cancelRequested = true;
      batch.current = 'Stopping…';
      await persistBatch();
    }
    return { ok: true, batch: publicBatch() };
  }

  async function clearBatch() {
    if (batch.running) {
      return { ok: false, error: 'Stop the running batch before clearing it' };
    }
    batch = idleBatch();
    await storageRemove(BATCH_KEY);
    setBadge('');
    return { ok: true, batch: publicBatch() };
  }

  async function runBatch(options: Settings) {
    const lastHostAt: Record<string, number> = {};
    for (const item of batch.items) {
      if (item.status !== 'pending') {
        continue;
      }
      if (batch.cancelRequested) {
        break;
      }
      // 同域名节流：前几个 OK、后几个被验证页拦，多是我们访问太快触发了目标站速率风控
      const host = hostOf(item.url);
      const since = Date.now() - (lastHostAt[host] || 0);
      if (lastHostAt[host] && since < SAME_HOST_MIN_GAP_MS) {
        batch.current = 'Pacing to avoid rate-limits…';
        await delay(SAME_HOST_MIN_GAP_MS - since);
        if (batch.cancelRequested) {
          break;
        }
      }
      lastHostAt[host] = Date.now();

      item.status = 'running';
      batch.current = item.url;
      setBadge(`${batch.done + 1}/${batch.total}`);
      await persistBatch();

      let shouldCharge = false;
      try {
        const result = await captureUrl(item, options);
        item.fileName = result.fileName;
        item.warning = result.warning;
        item.status = 'success';
        batch.success += 1;
        if (!batch.pro && !item.usageRecorded) {
          item.usageRecorded = true;
          shouldCharge = true;
        }
      } catch (error) {
        item.status = 'failed';
        item.error = normalizeError(error);
        batch.failed += 1;
      }
      batch.done = batch.success + batch.failed;
      await persistBatch();
      if (shouldCharge) {
        // Persist success first: a worker suspension can at worst grant one free capture,
        // but will never resume the item and charge/download it twice.
        await recordUsage(1);
      }
    }

    batch.running = false;
    batch.current = batch.cancelRequested ? 'Stopped' : 'Done';
    batch.needVerify = null;
    await persistBatch();
    setBadge(batch.failed ? 'ERR' : 'OK');
    setTimeout(() => setBadge(''), 4000);
  }

  // 遇真人验证挑战（多为批量访问触发的速率风控）→ 退避后重试，等风控窗口冷却
  async function captureUrl(item: BatchItem, options: Settings) {
    const maxChallengeRetry = 2;
    let lastError: unknown;
    // 先后台静默尝试；命中验证页多为访问过快触发的速率风控，退避后重试（不打扰用户）
    for (let attempt = 0; attempt <= maxChallengeRetry; attempt += 1) {
      if (batch.cancelRequested) {
        throw new Error('Cancelled');
      }
      try {
        return await captureOnce(item, options, false);
      } catch (error) {
        lastError = error;
        if (!isChallengeError(error)) {
          throw error;
        }
        if (attempt < maxChallengeRetry) {
          const backoff = 8000 * (attempt + 1);
          batch.current = `Rate-limited — cooling down ${backoff / 1000}s (retry ${attempt + 1}/${maxChallengeRetry})`;
          await delay(backoff);
        }
      }
    }
    // 退避仍被拦 → 多为真·人机验证，机器过不去（attach debugger 会让 webdriver=true）。
    // 切到前台请用户手动完成验证，通过后再继续
    if (isChallengeError(lastError) && !batch.cancelRequested) {
      return await captureOnce(item, options, true);
    }
    throw lastError;
  }

  async function captureOnce(item: BatchItem, options: Settings, interactive: boolean) {
    const tab = await chrome.tabs.create({ url: item.url, active: Boolean(interactive) });
    const tabId = tab.id;
    if (!tabId) {
      throw new Error('Could not open tab');
    }

    const target: DebuggerTarget = { tabId };
    let attached = false;
    try {
      await waitForLoad(tabId, LOAD_TIMEOUT_MS);
      await delay(Number(options.delayMs) || 0);
      if (batch.cancelRequested) {
        throw new Error('Cancelled');
      }

      // 用 debugger 探测页面状态（body 检测比标题更稳）。attach 会置 navigator.webdriver=true，
      // 仅用于探测；命中挑战且需交互时立即 detach，让用户在 webdriver=false 的干净页面完成验证
      await debuggerAttach(target, '1.3');
      attached = true;
      await sendCommand(target, 'Page.enable');
      await sendCommand(target, 'Runtime.enable');

      const probe = await probePage(target);
      if (probe.error) {
        throw new Error(probe.error);
      }
      if (probe.challenge) {
        if (!interactive) {
          // 后台静默阶段：抛挑战错误交上层退避重试
          throw challengeError(probe.challenge);
        }
        // 交互阶段：detach（webdriver 归 false）+ 切前台，请用户手动完成验证，通过后再 re-attach
        await debuggerDetach(target).catch(() => {});
        attached = false;
        await focusTab(tabId);
        batch.needVerify = { url: item.url, challenge: probe.challenge };
        batch.current = `Complete ${probe.challenge} verification in the opened tab…`;
        await persistBatch();
        batch.skipVerify = false;
        const passed = await waitForVerification(tabId, () => batch.cancelRequested || batch.skipVerify);
        batch.needVerify = null;
        batch.current = item.url;
        await persistBatch();
        if (!passed) {
          throw challengeError(`${probe.challenge} verification not completed`);
        }
        // 用户已通过（此时已拿到放行 cookie），重新 attach；webdriver=true 不再影响
        await delay(800);
        await debuggerAttach(target, '1.3');
        attached = true;
        await sendCommand(target, 'Page.enable');
        await sendCommand(target, 'Runtime.enable');
      }

      const ctx = makeContext('batch', tabId, item.url, options, target);
      if (config.beforeScroll) {
        await config.beforeScroll(ctx);
      }

      // 关键：平滑滚动整页触发懒加载（顶部 hero、底部 footer、lazy 图片），再滚回顶部，
      // 否则未进视口的内容不会渲染，输出是空白
      await autoScroll(target);
      // 揭示滚动触发动画（AOS/scroll-reveal 等）：滚回顶部后 once:false 的动画会重置为
      // opacity:0，导致中间大片空白——强制把它们置为已显示状态
      await revealAnimations(target);
      await delay(400);

      const output: CaptureOutput = await config.capture(ctx);
      const fileName = buildBatchFileName(batch.folder, item, output.extension);
      // 大文件用 blob 下载：data: URL 超过约 2MB 时 Chrome 会忽略 filename
      await downloader.downloadViaBlob(output.base64, output.mime, fileName);
      return { fileName, warning: output.warning || '' };
    } finally {
      if (attached) {
        await debuggerDetach(target).catch(() => {});
      }
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  function makeContext(
    mode: 'batch' | 'quick',
    tabId: number,
    url: string,
    options: Settings,
    target: DebuggerTarget,
  ): CaptureContext {
    return {
      mode,
      tabId,
      url,
      options,
      send: (method, params) => sendCommand(target, method, params),
    };
  }

  function publicBatch() {
    return {
      running: batch.running,
      total: batch.total,
      done: batch.done,
      success: batch.success,
      failed: batch.failed,
      current: batch.current,
      folder: batch.folder,
      freeLimited: batch.freeLimited,
      needVerify: batch.needVerify,
      items: batch.items.map((item) => ({
        url: item.url,
        index: item.index,
        status: item.status,
        fileName: item.fileName,
        error: item.error,
        warning: item.warning,
      })),
    };
  }

  async function persistBatch() {
    await storageSet({ [BATCH_KEY]: batch });
  }

  async function restoreBatch() {
    const data = await storageGet(BATCH_KEY);
    const saved = data[BATCH_KEY] as (Partial<BatchState> & { items?: Partial<BatchItem>[] }) | undefined;
    if (!saved?.items?.length) {
      return;
    }
    batch = { ...idleBatch(), ...saved } as BatchState;
    batch.settings = { ...config.defaultSettings, ...(saved.settings || {}) };
    batch.items = saved.items.map((item) => ({
      url: item.url || '',
      index: item.index || 0,
      status: item.status === 'running' ? 'pending' : item.status || 'pending',
      fileName: item.fileName || '',
      error: item.error || '',
      warning: item.warning || '',
      usageRecorded: item.usageRecorded || false,
    }));
    batch.done = batch.items.filter((item) => item.status === 'success' || item.status === 'failed').length;
    batch.success = batch.items.filter((item) => item.status === 'success').length;
    batch.failed = batch.items.filter((item) => item.status === 'failed').length;
    batch.needVerify = null;
    batch.skipVerify = false;

    // MV3 service workers may be suspended mid-run. Continue remaining items after restart.
    if (saved.running && batch.items.some((item) => item.status === 'pending')) {
      batch.running = true;
      batch.cancelRequested = false;
      batch.current = 'Resuming interrupted batch…';
      await persistBatch();
      runBatch(batch.settings).catch(async (error) => {
        batch.running = false;
        batch.current = normalizeError(error);
        await persistBatch();
      });
    } else if (saved.running) {
      batch.running = false;
      batch.current = 'Done';
      await persistBatch();
    }
  }

  function setBadge(text: string) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: config.badgeColor });
  }
}
