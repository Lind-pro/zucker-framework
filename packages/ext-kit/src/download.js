import { cancelled, throwIfAborted } from './util.js';
function createDownloader(justification, options = {}) {
  const deadlineMs = options.deadlineMs ?? 120000;
  const blobLeaseMs = options.blobLeaseMs ?? 180000;
  const pollMs = options.pollMs ?? 1000;
  if (![deadlineMs, blobLeaseMs, pollMs].every((n) => Number.isFinite(n) && n > 0) || blobLeaseMs <= deadlineMs)
    throw new RangeError('Invalid download deadline, polling or blob lease');
  const names = new Map();
  const waiters = new Map();
  let offscreenSetup = null;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const filename = names.get(item.url) || names.get(item.finalUrl);
    if (filename) suggest({ filename, conflictAction: "uniquify" });
  });
  // Registered at worker startup; recovery also queries state, closing the event/listener race.
  chrome.downloads.onChanged.addListener((delta) => {
    if (
      delta.state?.current === "complete" ||
      delta.state?.current === "interrupted"
    )
      waiters.get(delta.id)?.();
  });
  async function ensureOffscreen() {
    if (!offscreenSetup)
      offscreenSetup = (async () => {
        if (!(await chrome.offscreen.hasDocument()))
          await chrome.offscreen.createDocument({
            url: options.offscreenUrl || "offscreen.html",
            reasons: [chrome.offscreen.Reason.BLOBS],
            justification,
          });
      })().finally(() => {
        offscreenSetup = null;
      });
    return offscreenSetup;
  }
  async function cleanup(url) {
    names.delete(url);
    if (url)
      await chrome.runtime
        .sendMessage({ target: "offscreen", type: "REVOKE_BLOB_URL", url })
        .catch(() => {});
  }
  async function waitForDownload(id, signal) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let deadlineError;
      const finish = (error, item) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        waiters.delete(id);
        error ? reject(error) : resolve(item);
      };
      const inspect = async () => {
        try {
          const [item] = await chrome.downloads.search({ id });
          if (!item) return finish(new Error("Download no longer exists"));
          if (item.state === "complete") finish(null, item);
          else if (item.state === "interrupted")
            finish(
              deadlineError || new Error(
                item.error === "USER_CANCELED"
                  ? "Cancelled"
                  : `Download interrupted: ${item.error || "unknown error"}`,
              ),
            );
        } catch (error) {
          finish(error);
        }
      };
      const abort = async () => {
        await chrome.downloads.cancel(id).catch(() => {});
        // A file that was already complete is still a successful output, even if Stop raced with its final event.
        const [item] = await chrome.downloads.search({ id }).catch(() => []);
        item?.state === "complete" ? finish(null, item) : finish(cancelled());
      };
      const poll = setInterval(inspect, pollMs);
      const timeout = setTimeout(async () => {
        // Chrome may synchronously emit interrupted during cancel(). Keep the
        // deadline reason rather than misreporting this as a user cancellation.
        deadlineError = new Error("Download completion timed out");
        await chrome.downloads.cancel(id).catch(() => {});
        finish(deadlineError);
      }, deadlineMs);
      waiters.set(id, inspect);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) void abort();
      else void inspect();
    });
  }
  async function recover(item, signal) {
    const matches =
      item.downloadId != null
        ? await chrome.downloads.search({ id: item.downloadId })
        : await chrome.downloads.search({
            url: `^${item.downloadUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          });
    const download = matches.find(
      (d) =>
        d.byExtensionId === chrome.runtime.id &&
        (!item.downloadUrl || d.url === item.downloadUrl),
    );
    if (!download) {
      await cleanup(item.downloadUrl);
      throw new Error(
        "Interrupted download could not be confirmed. Retry this page.",
      );
    }
    try {
      return await waitForDownload(download.id, signal);
    } finally {
      await cleanup(item.downloadUrl);
    }
  }
  async function downloadViaBlob(
    base64,
    mime,
    filename,
    { signal, onPrepared, onCreated } = {},
  ) {
    throwIfAborted(signal);
    await ensureOffscreen();
    throwIfAborted(signal);
    const created = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CREATE_BLOB_URL",
      base64,
      mime,
      leaseMs: blobLeaseMs,
    });
    if (!created?.ok || !created.url)
      throw new Error(created?.error || "Failed to prepare download");
    const url = created.url;
    names.set(url, filename);
    let downloadId;
    try {
      await onPrepared?.(url);
      throwIfAborted(signal);
      downloadId = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      await onCreated?.(downloadId);
      await waitForDownload(downloadId, signal);
      return downloadId;
    } catch (error) {
      if (downloadId != null)
        await chrome.downloads.cancel(downloadId).catch(() => {});
      throw error;
    } finally {
      await cleanup(url);
    }
  }
  return { downloadViaBlob, recover };
}

export { createDownloader };
