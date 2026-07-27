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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return;
  }
  if (message.type === "CREATE_BLOB_URL") {
    try {
      const blob = new Blob([base64ToBytes(message.base64)], { type: message.mime });
      sendResponse({ ok: true, url: URL.createObjectURL(blob) });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return;
  }
  if (message.type === "REVOKE_BLOB_URL") {
    URL.revokeObjectURL(message.url);
    sendResponse({ ok: true });
  }
});
