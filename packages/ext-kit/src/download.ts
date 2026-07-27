export interface Downloader {
  downloadViaBlob(base64: string, mime: string, filename: string): Promise<number>;
}

export function createDownloader(justification: string): Downloader {
  const pendingDownloadNames = new Map<string, string>();
  let offscreenSetup: Promise<void> | null = null;

  // Chrome may replace filenames for offscreen-created blob: URLs with a UUID.
  // Re-assert the relative path at filename determination time so the batch folder is preserved.
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const fileName = pendingDownloadNames.get(item.url) || pendingDownloadNames.get(item.finalUrl || '');
    if (!fileName) {
      return;
    }
    suggest({ filename: fileName, conflictAction: 'uniquify' });
    return true;
  });

  async function ensureOffscreen(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      return;
    }
    if (!offscreenSetup) {
      offscreenSetup = chrome.offscreen
        .createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.BLOBS],
          justification,
        })
        .catch((error: unknown) => {
          // 已存在时并发创建会报错，忽略
          if (!String((error as Error)?.message || '').includes('Only a single')) {
            throw error;
          }
        })
        .finally(() => {
          offscreenSetup = null;
        });
    }
    return offscreenSetup;
  }

  // 通过 offscreen document 把 base64 转成 blob URL 再下载：
  // data: URL 超过约 2MB 时 chrome.downloads 会忽略 filename 回退默认名（"下载"）。
  async function downloadViaBlob(base64: string, mime: string, filename: string): Promise<number> {
    await ensureOffscreen();
    const created = (await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'CREATE_BLOB_URL',
      base64,
      mime,
    })) as { ok?: boolean; url?: string; error?: string } | undefined;
    if (!created?.ok || !created.url) {
      throw new Error(created?.error || 'Failed to prepare download');
    }
    const url = created.url;
    pendingDownloadNames.set(url, filename);
    const cleanup = () => {
      pendingDownloadNames.delete(url);
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'REVOKE_BLOB_URL', url })
        .catch(() => {});
    };
    try {
      const downloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download(
          { url, filename, conflictAction: 'uniquify', saveAs: false },
          (id) => {
            const error = chrome.runtime.lastError;
            error ? reject(new Error(error.message)) : resolve(id);
          },
        );
      });
      // 下载已开始读取 blob，延迟释放确保落盘完成
      setTimeout(cleanup, 60000);
      return downloadId;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  return { downloadViaBlob };
}
