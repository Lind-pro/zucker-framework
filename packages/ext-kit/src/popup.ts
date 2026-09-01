import type { PopupConfig, Settings } from './types';

interface QueueItem {
  url: string;
  selected: boolean;
}

interface BatchView {
  running: boolean;
  total: number;
  done: number;
  current: string;
  folder: string;
  freeLimited: boolean;
  needVerify: { url: string; challenge: string } | null;
  items: {
    url: string;
    status: string;
    error?: string;
    warning?: string;
  }[];
}

interface QuotaView {
  pro: boolean;
  expiresAt?: string;
  limit: number | null;
  remaining: number;
}

type SendResponse = {
  ok: boolean;
  error?: string;
  batch?: BatchView;
  quota?: QuotaView;
  result?: { fileName: string; warning?: string };
};

export function initPopup(config: PopupConfig): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const el = {
    urls: byId('urls') as HTMLTextAreaElement,
    urlCount: byId('urlCount'),
    addUrls: byId('addUrls') as HTMLButtonElement,
    scanSite: byId('scanSite') as HTMLButtonElement,
    queueSummary: byId('queueSummary'),
    queueList: byId('queueList'),
    selectAll: byId('selectAll') as HTMLButtonElement,
    selectNone: byId('selectNone') as HTMLButtonElement,
    moreQueueActions: byId('moreQueueActions') as HTMLButtonElement,
    queueMenu: byId('queueMenu'),
    removeUnselected: byId('removeUnselected') as HTMLButtonElement,
    clearQueue: byId('clearQueue') as HTMLButtonElement,
    captureCurrent: byId(config.quickButtonId || 'captureCurrent') as HTMLButtonElement,
    start: byId('start') as HTMLButtonElement,
    cancel: byId('cancel') as HTMLButtonElement,
    progressWrap: byId('progressWrap'),
    progressText: byId('progressText'),
    progressCurrent: byId('progressCurrent'),
    clearBatch: byId('clearBatch') as HTMLButtonElement,
    progressBar: byId('progressBar'),
    resultList: byId('resultList'),
    verifyBanner: byId('verifyBanner'),
    verifyText: byId('verifyText'),
    skipVerify: byId('skipVerify') as HTMLButtonElement,
    folderNote: byId('folderNote'),
    quotaText: byId('quotaText'),
    proLink: byId('proLink'),
    haveCode: byId('haveCode') as HTMLButtonElement,
    licensePanel: byId('licensePanel'),
    licenseCode: byId('licenseCode') as HTMLInputElement,
    activateBtn: byId('activateBtn') as HTMLButtonElement,
    deactivateBtn: byId('deactivateBtn') as HTMLButtonElement,
    status: byId('status'),
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let queue: QueueItem[] = [];
  let queueLocked = false;
  const prefix = config.messagePrefix;

  void init();

  async function init() {
    el.urls.addEventListener('input', updateUrlCount);
    el.addUrls.addEventListener('click', addInputUrls);
    el.scanSite.addEventListener('click', scanCurrentSite);
    el.selectAll.addEventListener('click', () => setAllSelected(true));
    el.selectNone.addEventListener('click', () => setAllSelected(false));
    el.moreQueueActions.addEventListener('click', () => el.queueMenu.classList.toggle('hidden'));
    el.removeUnselected.addEventListener('click', removeUnselected);
    el.clearQueue.addEventListener('click', clearQueue);
    el.captureCurrent.addEventListener('click', quickCapture);
    el.start.addEventListener('click', startBatch);
    el.cancel.addEventListener('click', cancelBatch);
    el.clearBatch.addEventListener('click', clearBatchResults);
    el.skipVerify.addEventListener('click', () => send({ type: `${prefix}_SKIP_VERIFY` }));
    el.haveCode.addEventListener('click', () => el.licensePanel.classList.toggle('hidden'));
    el.activateBtn.addEventListener('click', activateLicense);
    el.deactivateBtn.addEventListener('click', deactivateLicense);
    await loadQueue();
    updateUrlCount();
    renderQueue();
    await refreshState();
  }

  async function activateLicense() {
    const code = el.licenseCode.value.trim();
    if (!code) {
      setStatus('Paste your activation code first', true);
      return;
    }
    el.activateBtn.disabled = true;
    setStatus('Activating…');
    const response = await send({ type: `${prefix}_ACTIVATE`, code });
    el.activateBtn.disabled = false;
    if (!response.ok) {
      setStatus(response.error || 'Activation failed', true);
      return;
    }
    el.licenseCode.value = '';
    el.licensePanel.classList.add('hidden');
    renderQuota(response.quota);
    setStatus('Pro activated — enjoy unlimited pages!');
  }

  async function deactivateLicense() {
    const response = await send({ type: `${prefix}_CLEAR_LICENSE` });
    if (response.ok) {
      renderQuota(response.quota);
      setStatus('License removed from this device');
    }
  }

  function parseUrls(): string[] {
    return normalizeInputUrls(el.urls.value.split(/\s+/));
  }

  function updateUrlCount() {
    el.urlCount.textContent = String(parseUrls().length);
  }

  function normalizeInputUrls(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      try {
        const url = new URL(String(value || '').trim());
        if (!/^https?:$/.test(url.protocol)) {
          continue;
        }
        url.hash = '';
        const normalized = url.toString();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      } catch {
        // Ignore non-URL text in bulk input.
      }
    }
    return out;
  }

  function addInputUrls() {
    const urls = parseUrls();
    if (!urls.length) {
      setStatus('Paste at least one valid http(s) URL', true);
      return;
    }
    const added = addUrlsToQueue(urls);
    el.urls.value = '';
    updateUrlCount();
    setStatus(
      added
        ? `Added ${added} URL${added === 1 ? '' : 's'} to the queue`
        : 'Those URLs are already in the queue',
    );
  }

  function addUrlsToQueue(urls: string[]): number {
    const existing = new Set(queue.map((item) => item.url));
    let added = 0;
    for (const url of normalizeInputUrls(urls)) {
      if (!existing.has(url) && queue.length < 500) {
        queue.push({ url, selected: true });
        existing.add(url);
        added += 1;
      }
    }
    if (added) {
      saveQueue();
      renderQueue();
    }
    return added;
  }

  async function scanCurrentSite() {
    setStatus('Scanning current tab…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error('No active tab');
      }
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectSameOriginLinks,
      });
      const scan = (result?.result as { urls: string[]; sitemapCount: number } | undefined) || {
        urls: [],
        sitemapCount: 0,
      };
      const found = scan.urls || [];
      if (!found.length) {
        setStatus('No same-site links found on this page', true);
        return;
      }
      const added = addUrlsToQueue(found);
      const sitemapNote = scan.sitemapCount ? `, including ${scan.sitemapCount} from sitemap` : '';
      setStatus(`Found ${found.length} same-site URLs${sitemapNote}; added ${added} new`);
    } catch (error) {
      setStatus(errText(error), true);
    }
  }

  async function startBatch() {
    const urls = queue.filter((item) => item.selected).map((item) => item.url);
    if (!urls.length) {
      setStatus('Select at least one URL from the queue', true);
      return;
    }
    el.start.disabled = true;
    setStatus('Starting…');
    const response = await send({
      type: `${prefix}_START`,
      urls,
      settings: config.collectSettings(),
    });
    el.start.disabled = false;
    if (!response.ok) {
      setStatus(response.error || 'Failed to start', true);
      return;
    }
    renderBatch(response.batch);
    renderQuota(response.quota);
    schedulePoll();
    setStatus(
      response.batch?.freeLimited
        ? "Started (list truncated to today's free quota)"
        : 'Batch started',
    );
  }

  async function quickCapture() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
      setStatus('Open an http(s) website first', true);
      return;
    }
    el.captureCurrent.disabled = true;
    el.start.disabled = true;
    setStatus(config.texts.quickIng);
    const response = await send({
      type: `${prefix}_${config.quickType}`,
      tabId: tab.id,
      settings: config.collectQuickSettings(),
    });
    el.captureCurrent.disabled = false;
    renderQueue();
    if (!response.ok || !response.result) {
      setStatus(response.error || config.texts.quickFailed, true);
      return;
    }
    renderQuota(response.quota);
    setStatus(config.quickResult(response.result));
  }

  async function cancelBatch() {
    const response = await send({ type: `${prefix}_CANCEL` });
    if (response.ok) {
      renderBatch(response.batch);
    }
  }

  async function clearBatchResults() {
    const response = await send({ type: `${prefix}_CLEAR_BATCH` });
    if (!response.ok) {
      setStatus(response.error || 'Could not clear results', true);
      return;
    }
    renderBatch(response.batch);
    setStatus('Batch results cleared');
  }

  async function refreshState() {
    const response = await send({ type: `${prefix}_STATE` });
    if (!response.ok) {
      return;
    }
    renderQuota(response.quota);
    renderBatch(response.batch);
    if (response.batch?.running) {
      schedulePoll();
    }
  }

  function schedulePoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(async () => {
      const response = await send({ type: `${prefix}_STATE` });
      if (!response.ok) {
        return;
      }
      renderQuota(response.quota);
      renderBatch(response.batch);
      if (!response.batch?.running && pollTimer) {
        clearInterval(pollTimer);
      }
    }, 800);
  }

  function renderQuota(quota?: QuotaView) {
    if (!quota) {
      return;
    }
    if (quota.pro) {
      const until = quota.expiresAt ? ` · ${String(quota.expiresAt).slice(0, 10)}` : '';
      el.quotaText.textContent = `unlimited${until}`;
      el.proLink.classList.add('hidden');
      el.deactivateBtn.classList.remove('hidden');
      el.activateBtn.classList.add('hidden');
    } else {
      el.quotaText.textContent = `${quota.remaining}/${quota.limit} today`;
      el.proLink.classList.remove('hidden');
      el.deactivateBtn.classList.add('hidden');
      el.activateBtn.classList.remove('hidden');
    }
  }

  function renderBatch(batch?: BatchView) {
    if (!batch) {
      return;
    }
    el.start.classList.toggle('hidden', batch.running);
    el.captureCurrent.classList.toggle('hidden', batch.running);
    el.cancel.classList.toggle('hidden', !batch.running);
    queueLocked = batch.running;
    renderQueue();
    el.progressWrap.classList.toggle('hidden', !batch.total);
    el.clearBatch.classList.toggle('hidden', batch.running || !batch.total);

    if (batch.total) {
      el.progressText.textContent = `${batch.done} / ${batch.total}`;
      el.progressCurrent.textContent = batch.current || '';
      el.progressBar.style.width = `${batch.total ? Math.round((batch.done / batch.total) * 100) : 0}%`;
    }

    const verify = batch.needVerify;
    el.verifyBanner.classList.toggle('hidden', !verify);
    if (verify) {
      el.verifyText.textContent = `${verify.challenge} · ${verify.url.replace(/^https?:\/\//, '')}`;
    }

    el.resultList.replaceChildren();
    for (const item of batch.items) {
      const rowEl = document.createElement('div');
      rowEl.className = 'resultItem';
      const state = document.createElement('span');
      state.className = `state ${item.status}`;
      state.textContent =
        ({ pending: '·', running: '…', success: '✓', failed: '✗' } as Record<string, string>)[
          item.status
        ] || '·';
      const url = document.createElement('span');
      url.className = 'url';
      url.textContent = item.url.replace(/^https?:\/\//, '');
      rowEl.append(state, url);
      if (item.error) {
        const err = document.createElement('span');
        err.className = 'err';
        err.textContent = item.error.slice(0, 60);
        rowEl.append(err);
      }
      if (item.warning) {
        const warning = document.createElement('span');
        warning.className = 'warning';
        warning.textContent = item.warning.slice(0, 100);
        rowEl.append(warning);
      }
      el.resultList.append(rowEl);
    }

    if (batch.folder && batch.done > 0) {
      el.folderNote.classList.remove('hidden');
      el.folderNote.textContent = `Saved to Downloads/${batch.folder}/`;
    } else {
      el.folderNote.classList.add('hidden');
      el.folderNote.textContent = '';
    }
  }

  async function loadQueue() {
    const data = await chrome.storage.local.get(config.queueKey);
    const saved = Array.isArray(data[config.queueKey]) ? (data[config.queueKey] as QueueItem[]) : [];
    queue = saved
      .filter((item) => item && typeof item.url === 'string')
      .slice(0, 500)
      .map((item) => ({ url: item.url, selected: item.selected !== false }));
  }

  function saveQueue() {
    void chrome.storage.local.set({ [config.queueKey]: queue });
  }

  function renderQueue() {
    const selected = queue.filter((item) => item.selected).length;
    el.queueSummary.textContent = `${selected}/${queue.length} selected`;
    el.start.textContent = selected ? config.texts.startSome(selected) : config.texts.startNone;
    el.start.disabled = selected === 0;
    el.selectAll.disabled = queueLocked || !queue.length;
    el.selectNone.disabled = queueLocked || !queue.length;
    el.moreQueueActions.disabled = queueLocked || !queue.length;
    el.addUrls.disabled = queueLocked;
    el.scanSite.disabled = queueLocked;
    el.captureCurrent.disabled = queueLocked;
    el.queueList.replaceChildren();

    if (!queue.length) {
      const empty = document.createElement('p');
      empty.className = 'queueEmpty';
      empty.textContent = 'Add URLs or scan the current site to begin.';
      el.queueList.append(empty);
      return;
    }

    queue.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `queueItem${item.selected ? '' : ' unselected'}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.selected;
      checkbox.disabled = queueLocked;
      checkbox.setAttribute('aria-label', `Include ${item.url}`);
      checkbox.addEventListener('change', () => {
        item.selected = checkbox.checked;
        saveQueue();
        renderQueue();
      });

      const url = document.createElement('button');
      url.type = 'button';
      url.className = 'queueUrl';
      url.textContent = item.url.replace(/^https?:\/\//, '');
      url.title = item.url;
      url.disabled = queueLocked;
      url.addEventListener('click', () => editQueueItem(index));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'queueRemove';
      remove.textContent = '×';
      remove.title = 'Remove URL';
      remove.disabled = queueLocked;
      remove.addEventListener('click', () => {
        queue.splice(index, 1);
        saveQueue();
        renderQueue();
      });
      row.append(checkbox, url, remove);
      el.queueList.append(row);
    });
  }

  function editQueueItem(index: number) {
    const current = queue[index];
    const value = prompt('Edit URL', current.url);
    if (value === null) {
      return;
    }
    const [normalized] = normalizeInputUrls([value]);
    if (!normalized) {
      setStatus('Enter a valid http(s) URL', true);
      return;
    }
    if (queue.some((item, itemIndex) => itemIndex !== index && item.url === normalized)) {
      setStatus('That URL is already in the queue', true);
      return;
    }
    current.url = normalized;
    saveQueue();
    renderQueue();
  }

  function setAllSelected(selected: boolean) {
    if (queueLocked) {
      return;
    }
    queue.forEach((item) => {
      item.selected = selected;
    });
    saveQueue();
    renderQueue();
  }

  function removeUnselected() {
    queue = queue.filter((item) => item.selected);
    el.queueMenu.classList.add('hidden');
    saveQueue();
    renderQueue();
  }

  function clearQueue() {
    queue = [];
    el.queueMenu.classList.add('hidden');
    saveQueue();
    renderQueue();
  }

  function send(message: Record<string, unknown>): Promise<SendResponse> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        resolve(
          error
            ? { ok: false, error: error.message }
            : (response as SendResponse) || { ok: false, error: 'No response' },
        );
      });
    });
  }

  function setStatus(text: string, isError = false) {
    el.status.textContent = text;
    el.status.classList.toggle('error', isError);
  }

  function errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// 注入到当前 tab 收集同源链接（含 sitemap）。activeTab 权限在页面上下文里生效。
// 注意：chrome.scripting 序列化后在页面里独立执行，不能引用外部作用域。
async function collectSameOriginLinks() {
  const seen = new Set<string>();
  const out: string[] = [];
  const origin = location.origin;
  let sitemapCount = 0;
  const add = (value: string | null): boolean => {
    try {
      const url = new URL(value || '', location.href);
      url.hash = '';
      if (
        url.origin === origin &&
        /^https?:$/.test(url.protocol) &&
        !seen.has(url.toString()) &&
        out.length < 500
      ) {
        seen.add(url.toString());
        out.push(url.toString());
        return true;
      }
    } catch {
      // Ignore malformed URLs.
    }
    return false;
  };
  add(location.href);
  for (const a of document.querySelectorAll('a[href]')) {
    add(a.getAttribute('href'));
    if (out.length >= 500) {
      break;
    }
  }

  // Fetch same-origin sitemap files from the page context, where activeTab access applies.
  const sitemapQueue = [new URL('/sitemap.xml', origin).toString()];
  const visitedSitemaps = new Set<string>();
  while (sitemapQueue.length && visitedSitemaps.size < 8 && out.length < 500) {
    const sitemapUrl = sitemapQueue.shift() as string;
    if (visitedSitemaps.has(sitemapUrl)) {
      continue;
    }
    visitedSitemaps.add(sitemapUrl);
    try {
      const response = await fetch(sitemapUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        continue;
      }
      const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
      for (const loc of xml.querySelectorAll('loc')) {
        const value = loc.textContent?.trim();
        if (!value) {
          continue;
        }
        if (/\.xml(?:\.gz)?(?:$|\?)/i.test(value)) {
          try {
            const nested = new URL(value, sitemapUrl);
            if (nested.origin === origin && !visitedSitemaps.has(nested.toString())) {
              sitemapQueue.push(nested.toString());
            }
          } catch {
            // Ignore malformed sitemap entries.
          }
        } else if (add(value)) {
          sitemapCount += 1;
        }
        if (out.length >= 500) {
          break;
        }
      }
    } catch {
      // Sitemaps are optional; DOM links remain useful when unavailable.
    }
  }
  return { urls: out, sitemapCount };
}
