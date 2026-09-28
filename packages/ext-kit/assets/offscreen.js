// Service worker 无法使用 URL.createObjectURL；大截图的 data: URL 超过约 2MB 时
// chrome.downloads 会忽略 filename。offscreen document 负责把 base64 转成
// blob: URL，让下载可靠、文件名生效。

function base64ToBytes(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// This document outlives a suspended worker. Every owned URL has a bounded lease.
const blobs = new Map();
function revoke(url) {
  if (!blobs.has(url)) return;
  URL.revokeObjectURL(url);
  clearTimeout(blobs.get(url));
  blobs.delete(url);
}
addEventListener('pagehide', () => {
  for (const url of blobs.keys()) revoke(url);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || (sender.id && sender.id !== chrome.runtime.id)) {
    return;
  }
  if (message.type === "CREATE_BLOB_URL") {
    try {
      const leaseMs = message.leaseMs ?? 180000;
      if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 2147483647)
        throw new RangeError('Invalid blob lease');
      const blob = new Blob([base64ToBytes(message.base64)], { type: message.mime });
      const url = URL.createObjectURL(blob);
      blobs.set(url, setTimeout(() => revoke(url), leaseMs));
      sendResponse({ ok: true, url });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return;
  }
  if (message.type === "REVOKE_BLOB_URL") {
    revoke(message.url);
    sendResponse({ ok: true });
  }
});
