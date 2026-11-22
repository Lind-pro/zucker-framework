function initPopup(config) {
  const byId = (id) => document.getElementById(id);
  // Bound pathological messages without cutting the hint off ordinary ones.
  const clip = (text, max = 240) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const el = {
    urls: byId("urls"),
    urlCount: byId("urlCount"),
    addUrls: byId("addUrls"),
    scanSite: byId("scanSite"),
    queueSummary: byId("queueSummary"),
    queueList: byId("queueList"),
    selectAll: byId("selectAll"),
    selectNone: byId("selectNone"),
    moreQueueActions: byId("moreQueueActions"),
    queueMenu: byId("queueMenu"),
    removeUnselected: byId("removeUnselected"),
    clearQueue: byId("clearQueue"),
    captureCurrent: byId(config.quickButtonId || "captureCurrent"),
    start: byId("start"),
    cancel: byId("cancel"),
    progressWrap: byId("progressWrap"),
    progressText: byId("progressText"),
    progressCurrent: byId("progressCurrent"),
    clearBatch: byId("clearBatch"),
    progressBar: byId("progressBar"),
    resultList: byId("resultList"),
    verifyBanner: byId("verifyBanner"),
    verifyText: byId("verifyText"),
    skipVerify: byId("skipVerify"),
    folderNote: byId("folderNote"),
    quotaText: byId("quotaText"),
    proLink: byId("proLink"),
    haveCode: byId("haveCode"),
    licensePanel: byId("licensePanel"),
    licenseCode: byId("licenseCode"),
    activateBtn: byId("activateBtn"),
    deactivateBtn: byId("deactivateBtn"),
    recheckLicense: byId("recheckLicense"),
    licenseHint: byId("licenseHint"),
    status: byId("status"),
  };
  let pollTimer = null;
  let disposed = false;
  window.addEventListener('pagehide', () => {
    disposed = true;
    pollGeneration++;
    clearTimeout(pollTimer);
    if (scanJob) {
      const job = scanJob;
      scanJob = null;
      void chrome.scripting.executeScript({
        target: { tabId: job.tabId }, func: collectSameOriginLinks,
        args: [{ phase: 'cancel', id: job.id }],
      }).catch(() => {});
    }
  }, { once: true });
  let queue = [];
  let queueLocked = false;
  let operationBusy = false;
  let editingIndex = -1;
  let scanJob = null;
  let pollGeneration = 0;
  const settingsKey =
    config.settingsKey || config.queueKey.replace(/_url_queue$/, "_settings");
  const settingFields = () =>
    document.querySelectorAll(
      ".settings select, .settings input[data-setting]",
    );
  let savedSettings = {};
  const prefix = config.messagePrefix;
  void init().catch((error) => setStatus(errText(error), true));
  async function init() {
    el.urls.addEventListener("input", updateUrlCount);
    el.addUrls.addEventListener("click", addInputUrls);
    el.scanSite.addEventListener("click", scanCurrentSite);
    el.selectAll.addEventListener("click", () => setAllSelected(true));
    el.selectNone.addEventListener("click", () => setAllSelected(false));
    el.moreQueueActions.addEventListener("click", (event) => {
      event.stopPropagation();
      setQueueMenu(el.queueMenu.classList.contains("hidden"));
    });
    document.addEventListener("click", (event) => {
      if (
        !el.queueMenu.classList.contains("hidden") &&
        !el.queueMenu.contains(event.target)
      )
        setQueueMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !el.queueMenu.classList.contains("hidden")
      ) {
        setQueueMenu(false);
        el.moreQueueActions.focus();
      }
    });
    el.removeUnselected.addEventListener("click", removeUnselected);
    el.clearQueue.addEventListener("click", clearQueue);
    el.captureCurrent.addEventListener("click", quickCapture);
    el.start.addEventListener("click", startBatch);
    el.cancel.addEventListener("click", cancelBatch);
    el.clearBatch.addEventListener("click", clearBatchResults);
    el.skipVerify.addEventListener("click", () =>
      send({ type: `${prefix}_SKIP_VERIFY` }),
    );
    el.haveCode.addEventListener("click", () =>
      el.licensePanel.classList.toggle("hidden"),
    );
    el.activateBtn.addEventListener("click", activateLicense);
    el.deactivateBtn.addEventListener("click", deactivateLicense);
    el.recheckLicense?.addEventListener("click", recheckLicense);
    el.start.disabled = true;
    el.captureCurrent.disabled = true;
    await Promise.all([loadQueue(), loadSettings()]);
    config.onSettingsLoaded?.();
    settingFields().forEach((field) => {
      field.addEventListener("change", saveSettings);
      if (field.type === "number")
        field.addEventListener("input", saveSettings);
    });
    updateUrlCount();
    renderQueue();
    await refreshState();
  }
  function setQueueMenu(open) {
    el.queueMenu.classList.toggle("hidden", !open);
    el.moreQueueActions.setAttribute("aria-expanded", String(open));
  }
  async function activateLicense() {
    const code = el.licenseCode.value.trim();
    if (!code) {
      setStatus("Paste your activation code first", true);
      return;
    }
    el.activateBtn.disabled = true;
    setStatus("Activating\u2026");
    const response = await send({ type: `${prefix}_ACTIVATE`, code });
    el.activateBtn.disabled = false;
    if (!response.ok) {
      setStatus(response.error || "Activation failed", true);
      return;
    }
    el.licenseCode.value = "";
    el.licensePanel.classList.add("hidden");
    renderQuota(response.quota);
    setStatus("Pro activated \u2014 enjoy unlimited pages!");
  }
  async function deactivateLicense() {
    el.deactivateBtn.disabled = true;
    const response = await send({ type: `${prefix}_CLEAR_LICENSE` });
    el.deactivateBtn.disabled = false;
    if (response.ok) {
      renderQuota(response.quota);
      setStatus("Device released. Its license slot is now available.");
    } else setStatus(response.error || "Could not release this device", true);
  }
  async function recheckLicense() {
    el.recheckLicense.disabled = true;
    setStatus("Checking your Pro license…");
    const response = await send({ type: `${prefix}_REFRESH_LICENSE` });
    el.recheckLicense.disabled = false;
    if (!response.ok)
      return setStatus(
        response.error || "Could not check your license",
        true,
      );
    renderQuota(response.quota);
    setStatus(
      response.quota.pro
        ? "Pro confirmed — unlimited exports."
        : response.quota.licenseMessage ||
            "Enter your original activation code to restore Pro in this extension.",
      !response.quota.pro,
    );
  }
  function parseUrls() {
    return normalizeInputUrls(el.urls.value.split(/\s+/));
  }
  function updateUrlCount() {
    el.urlCount.textContent = String(parseUrls().length);
  }
  function normalizeInputUrls(values) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const value of values) {
      try {
        const url = new URL(String(value || "").trim());
        if (!/^https?:$/.test(url.protocol)) {
          continue;
        }
        // A fragment may identify a distinct application route.
        const normalized = url.toString();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      } catch {}
    }
    return out;
  }
  function addInputUrls() {
    const urls = parseUrls();
    if (!urls.length) {
      setStatus("Paste at least one valid http(s) URL", true);
      return;
    }
    const added = addUrlsToQueue(urls);
    el.urls.value = "";
    updateUrlCount();
    setStatus(
      added
        ? `Added ${added} URL${added === 1 ? "" : "s"} to the queue`
        : "Those URLs are already in the queue",
    );
  }
  function addUrlsToQueue(urls) {
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
    if (scanJob) {
      const stopped = scanJob;
      scanJob = null;
      await chrome.scripting
        .executeScript({
          target: { tabId: stopped.tabId },
          func: collectSameOriginLinks,
          args: [{ phase: "cancel", id: stopped.id }],
        })
        .catch(() => {});
      el.scanSite.textContent = "⌖ Scan site";
      setStatus("Scan stopped; imported links are kept");
      return;
    }
    if (queueLocked || operationBusy) return;
    let job;
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id || !/^https?:\/\//i.test(tab.url || ""))
        throw new Error("Open an http(s) website first");
      job = { tabId: tab.id, id: crypto.randomUUID() };
      scanJob = job;
      el.scanSite.textContent = "Stop scan";
      const [links] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectSameOriginLinks,
        args: [{ phase: "links" }],
      });
      if (scanJob !== job) return;
      const added = addUrlsToQueue(links?.result?.urls || []);
      setStatus(`Added ${added} page links; checking sitemap…`);
      const [maps] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectSameOriginLinks,
        args: [{ phase: "sitemap", id: job.id }],
      });
      if (scanJob !== job) return;
      if (queueLocked || operationBusy) {
        setStatus("Scan stopped when the task started; page links are kept");
        return;
      }
      const extra = addUrlsToQueue(maps?.result?.urls || []);
      setStatus(
        `Added ${added + extra} URLs${maps?.result?.incomplete ? "; some sitemaps could not be read" : ""}`,
      );
    } catch (error) {
      setStatus(errText(error), true);
    } finally {
      if (scanJob === job) {
        scanJob = null;
        el.scanSite.textContent = "⌖ Scan site";
      }
    }
  }
  async function startBatch() {
    const urls = queue
      .filter((item) => item.selected)
      .map((item) => item.url);
    if (!urls.length) {
      setStatus("Select at least one URL from the queue", true);
      return;
    }
    operationBusy = true;
    renderQueue();
    setStatus("Starting\u2026");
    let response;
    try {
      response = await send({
        type: `${prefix}_START`,
        urls,
        settings: await config.collectSettings(),
      });
    } catch (error) {
      response = { ok: false, error: errText(error) };
    }
    operationBusy = false;
    renderQueue();
    if (!response.ok) {
      setStatus(response.error || "Failed to start", true);
      return;
    }
    renderBatch(response.batch);
    renderQuota(response.quota);
    schedulePoll();
    setStatus(
      response.batch?.freeLimited
        ? "Started (list truncated to today's free quota)"
        : "Batch started",
    );
  }
  async function quickCapture() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
      setStatus("Open an http(s) website first", true);
      return;
    }
    operationBusy = true;
    renderQueue();
    el.cancel.classList.remove("hidden");
    setStatus(config.texts.quickIng);
    let response;
    try {
      response = await send({
        type: `${prefix}_${config.quickType}`,
        tabId: tab.id,
        settings: await config.collectQuickSettings(),
      });
    } catch (error) {
      response = { ok: false, error: errText(error) };
    }
    operationBusy = false;
    await refreshState();
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
      setStatus(response.error || "Could not clear results", true);
      return;
    }
    renderBatch(response.batch);
    setStatus("Batch results cleared");
    renderQuota(response.quota);
  }
  async function refreshState() {
    const response = await send({ type: `${prefix}_STATE` });
    if (!response.ok) {
      return;
    }
    renderQuota(response.quota);
    renderBatch(response.batch);
    if (
      response.batch?.running ||
      response.batch?.busy ||
      response.quota?.licenseRefreshing
    ) {
      schedulePoll();
    }
  }
  function schedulePoll() {
    if (disposed) return;
    clearTimeout(pollTimer);
    const generation = ++pollGeneration;
    async function poll() {
      const response = await send({ type: `${prefix}_STATE` });
      if (disposed || generation !== pollGeneration) return;
      if (response.ok) {
        renderQuota(response.quota);
        renderBatch(response.batch);
      }
      if (
        !response.ok ||
        response.batch?.running ||
        response.batch?.busy ||
        response.quota?.licenseRefreshing
      )
        pollTimer = setTimeout(poll, 800);
    }
    pollTimer = setTimeout(poll, 800);
  }
  function renderQuota(quota) {
    if (!quota) {
      return;
    }
    if (el.licenseHint)
      el.licenseHint.textContent =
        quota.licenseMessage ||
        (quota.pro
          ? "Your Pro license includes unlimited exports."
          : "Already purchased? Enter your original activation code to restore Pro in this extension and browser.");
    el.recheckLicense?.classList.toggle("hidden", !quota.hasLicense);
    el.proLink.classList.toggle("hidden", quota.pro || quota.hasLicense);
    el.deactivateBtn.classList.toggle("hidden", !quota.hasLicense);
    el.activateBtn.classList.toggle("hidden", quota.pro);
    if (quota.pro) {
      const until = quota.expiresAt
        ? ` \xB7 ${String(quota.expiresAt).slice(0, 10)}`
        : "";
      el.quotaText.textContent = `unlimited${until}`;
    } else if (quota.hasLicense) {
      el.quotaText.textContent =
        quota.licenseStatus === "checking"
          ? "Checking Pro…"
          : "Pro needs verification";
    } else {
      el.quotaText.textContent = `${quota.remaining}/${quota.limit} today`;
    }
  }
  function renderBatch(batch) {
    if (!batch) {
      return;
    }
    const busy = batch.running || batch.busy;
    // Stalled means the worker marked the batch running but no run is live.
    // Stop now reconciles it, so keep the queue editable and Clear reachable
    // instead of leaving the only way out as reloading the extension.
    const stalled = Boolean(batch.stalled);
    el.start.classList.toggle("hidden", busy);
    el.captureCurrent.classList.toggle("hidden", busy);
    el.cancel.classList.toggle("hidden", !busy);
    queueLocked = busy && !stalled;
    renderQueue(true);
    el.progressWrap.classList.toggle("hidden", !batch.total);
    el.clearBatch.classList.toggle(
      "hidden",
      (busy && !stalled) || !batch.total,
    );
    if (batch.total) {
      el.progressText.textContent = `${batch.done} / ${batch.total}`;
      el.progressCurrent.textContent = batch.current || "";
      el.progressBar.style.width = `${batch.total ? Math.round((batch.done / batch.total) * 100) : 0}%`;
    }
    const verify = batch.needVerify;
    el.verifyBanner.classList.toggle("hidden", !verify);
    if (verify) {
      el.verifyText.textContent = `${verify.challenge} \xB7 ${verify.url.replace(/^https?:\/\//, "")}`;
    }
    el.resultList.replaceChildren();
    for (const item of batch.items) {
      const rowEl = document.createElement("div");
      rowEl.className = "resultItem";
      const state = document.createElement("span");
      state.className = `state ${item.status}`;
      state.textContent =
        {
          pending: "\xB7",
          running: "\u2026",
          downloading: "↓",
          cancelled: "–",
          success: "\u2713",
          failed: "\u2717",
        }[item.status] || "\xB7";
      const url = document.createElement("span");
      url.className = "url";
      url.textContent = item.url.replace(/^https?:\/\//, "");
      rowEl.append(state, url);
      if (item.error) {
        const err = document.createElement("span");
        err.className = "err";
        // Errors end with the actionable hint; keep it, wrapping in the row.
        err.textContent = clip(item.error);
        err.title = item.error;
        rowEl.append(err);
      }
      if (item.warning) {
        const warning = document.createElement("span");
        warning.className = "warning";
        warning.textContent = clip(item.warning);
        warning.title = item.warning;
        rowEl.append(warning);
      }
      el.resultList.append(rowEl);
    }
    if (batch.folder && batch.success > 0) {
      el.folderNote.classList.remove("hidden");
      el.folderNote.textContent = `Saved to Downloads/${batch.folder}/`;
    } else {
      el.folderNote.classList.add("hidden");
      el.folderNote.textContent = "";
    }
  }
  async function loadSettings() {
    const data = await chrome.storage.local.get(settingsKey);
    const saved = data[settingsKey];
    if (!saved || typeof saved !== "object") return;
    settingFields().forEach((field) => {
      const value = String(saved[field.id]);
      if (
        field.tagName === "SELECT" &&
        [...field.options].some((option) => option.value === value)
      )
        field.value = value;
      if (
        field.type === "number" &&
        value.trim() &&
        Number.isFinite(Number(value))
      ) {
        const fallback = field.value;
        field.value = value;
        if (!field.checkValidity()) field.value = fallback;
      }
      savedSettings[field.id] = field.value;
    });
  }
  function saveSettings() {
    // Keep the last valid number while the user is clearing or editing a field.
    settingFields().forEach((field) => {
      if (
        field.type !== "number" ||
        (field.value.trim() &&
          Number.isFinite(field.valueAsNumber) &&
          field.checkValidity())
      )
        savedSettings[field.id] = field.value;
    });
    void chrome.storage.local
      .set({ [settingsKey]: { ...savedSettings } })
      .catch((error) => setStatus(errText(error), true));
  }
  async function loadQueue() {
    const data = await chrome.storage.local.get(config.queueKey);
    const saved = Array.isArray(data[config.queueKey])
      ? data[config.queueKey]
      : [];
    queue = saved
      .filter((item) => item && typeof item.url === "string")
      .slice(0, 500)
      .map((item) => ({ url: item.url, selected: item.selected !== false }));
  }
  function saveQueue() {
    void chrome.storage.local
      .set({ [config.queueKey]: queue })
      .catch((error) => setStatus(errText(error), true));
  }
  function renderQueue(preserveEditor = false) {
    if (queueLocked || operationBusy) editingIndex = -1;
    if (editingIndex >= queue.length) editingIndex = -1;
    const selected = queue.filter((item) => item.selected).length;
    el.queueSummary.textContent = `${selected}/${queue.length} selected`;
    el.start.textContent = selected
      ? config.texts.startSome(selected)
      : config.texts.startNone;
    el.start.disabled = operationBusy || queueLocked || selected === 0;
    el.selectAll.disabled = queueLocked || operationBusy || !queue.length;
    el.selectNone.disabled = queueLocked || operationBusy || !queue.length;
    el.moreQueueActions.disabled =
      queueLocked || operationBusy || !queue.length;
    el.addUrls.disabled = queueLocked || operationBusy;
    el.scanSite.disabled = queueLocked || operationBusy;
    el.captureCurrent.disabled = queueLocked || operationBusy;
    // Status/entitlement polling must not blur an editor or discard its draft.
    if (
      preserveEditor &&
      editingIndex >= 0 &&
      el.queueList.querySelector(".queueEdit")
    )
      return;
    el.queueList.replaceChildren();
    if (!queue.length) {
      const empty = document.createElement("p");
      empty.className = "queueEmpty";
      empty.textContent = "Add URLs or scan the current site to begin.";
      el.queueList.append(empty);
      return;
    }
    queue.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `queueItem${item.selected ? "" : " unselected"}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.selected;
      checkbox.disabled = queueLocked || operationBusy;
      checkbox.setAttribute("aria-label", `Include ${item.url}`);
      checkbox.addEventListener("change", () => {
        item.selected = checkbox.checked;
        saveQueue();
        renderQueue();
      });
      const url =
        index === editingIndex
          ? buildQueueEditor(item, index)
          : buildQueueLabel(item, index);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queueRemove";
      remove.textContent = "\xD7";
      remove.title = "Remove URL";
      remove.disabled = queueLocked || operationBusy;
      remove.addEventListener("click", () => {
        queue.splice(index, 1);
        editingIndex = -1;
        saveQueue();
        renderQueue();
      });
      row.append(checkbox, url, remove);
      el.queueList.append(row);
    });
  }
  function buildQueueLabel(item, index) {
    const url = document.createElement("button");
    url.type = "button";
    url.className = "queueUrl";
    url.textContent = item.url.replace(/^https?:\/\//, "");
    url.title = `${item.url}\nClick to edit`;
    url.disabled = queueLocked || operationBusy;
    url.addEventListener("click", () => {
      if (queueLocked || operationBusy) return;
      editingIndex = index;
      renderQueue();
    });
    return url;
  }
  // Edits happen in place. A native prompt() can dismiss the whole popup on some
  // platforms, which silently discards the edit.
  function buildQueueEditor(item, index) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "queueEdit";
    input.value = item.url;
    input.spellcheck = false;
    input.setAttribute("aria-label", `Edit ${item.url}`);
    const leaveEditor = () => {
      editingIndex = -1;
      const label = buildQueueLabel(item, index);
      input.parentElement
        ?.querySelector('input[type="checkbox"]')
        ?.setAttribute("aria-label", `Include ${item.url}`);
      // Only replace this field. Rebuilding the row during blur destroys the
      // button receiving the pointer click (e.g. Remove) before mouseup.
      input.replaceWith(label);
      return label;
    };
    const finish = (fromBlur) => {
      if (editingIndex !== index) return;
      const [normalized] = normalizeInputUrls([input.value]);
      const duplicate =
        normalized &&
        queue.some(
          (other, otherIndex) =>
            otherIndex !== index && other.url === normalized,
        );
      if (!normalized || duplicate) {
        const message = duplicate
          ? "That URL is already in the queue"
          : "Enter a valid http(s) URL";
        // Leaving the field must not trap focus in an invalid row.
        if (fromBlur) {
          setStatus(`${message} — edit discarded`, true);
          leaveEditor();
        } else {
          setStatus(message, true);
          input.focus();
          input.select();
        }
        return;
      }
      if (normalized !== item.url) {
        item.url = normalized;
        saveQueue();
        setStatus("URL updated");
      }
      const label = leaveEditor();
      if (!fromBlur) label.focus();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Escape") {
        // Do not let the queue menu's Escape handler see this.
        event.preventDefault();
        event.stopPropagation();
        leaveEditor().focus();
      }
    });
    input.addEventListener("blur", () => finish(true));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }
  function setAllSelected(selected) {
    if (queueLocked || operationBusy) {
      return;
    }
    queue.forEach((item) => {
      item.selected = selected;
    });
    saveQueue();
    renderQueue();
  }
  function removeUnselected() {
    if (queueLocked || operationBusy) return;
    queue = queue.filter((item) => item.selected);
    editingIndex = -1;
    setQueueMenu(false);
    saveQueue();
    renderQueue();
  }
  function clearQueue() {
    if (queueLocked || operationBusy) return;
    queue = [];
    editingIndex = -1;
    setQueueMenu(false);
    saveQueue();
    renderQueue();
  }
  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        resolve(
          error
            ? { ok: false, error: error.message }
            : response || { ok: false, error: "No response" },
        );
      });
    });
  }
  function setStatus(text, isError = false) {
    if (disposed) return;
    el.status.textContent = text;
    el.status.classList.toggle("error", isError);
  }
  function errText(error) {
    return error instanceof Error ? error.message : String(error);
  }
}
async function collectSameOriginLinks(options = {}) {
  const origin = location.origin,
    seen = new Set(),
    urls = [];
  const add = (value) => {
    try {
      const url = new URL(value || "", location.href);
      if (
        url.origin === origin &&
        /^https?:$/.test(url.protocol) &&
        !seen.has(url.href) &&
        urls.length < 500
      ) {
        seen.add(url.href);
        urls.push(url.href);
        return true;
      }
    } catch {}
    return false;
  };
  if (options.phase === "cancel") {
    const active = globalThis.__zuckerExtScan;
    if (active?.id === options.id) {
      active.cancelled = true;
      active.controller?.abort();
    }
    return { urls: [], cancelled: true };
  }
  if (options.phase !== "sitemap") {
    add(location.href);
    for (const a of document.querySelectorAll("a[href]"))
      add(a.getAttribute("href"));
  }
  if (options.phase === "links") return { urls, sitemapCount: 0 };
  const scan = { id: options.id, cancelled: false, controller: null };
  globalThis.__zuckerExtScan?.controller?.abort();
  globalThis.__zuckerExtScan = scan;
  const deadline = Date.now() + 6000;
  let incomplete = false,
    sitemapCount = 0;
  const queue = [new URL("/sitemap.xml", origin).href],
    visited = new Set();
  const sameOrigin = (value) => {
    try {
      const url = new URL(value, origin);
      return url.origin === origin && /^https?:$/.test(url.protocol)
        ? url.href
        : null;
    } catch {
      return null;
    }
  };
  async function read(url) {
    if (scan.cancelled || Date.now() >= deadline) {
      incomplete = true;
      return null;
    }
    const controller = new AbortController();
    scan.controller = controller;
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(1500, deadline - Date.now()),
    );
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024)
        throw new Error("Sitemap too large");
      let stream = response.body;
      // Browsers already decode Content-Encoding; gzip file bytes require separate decompression.
      const reader = stream.getReader();
      const first = await reader.read();
      const gzip = first.value?.[0] === 0x1f && first.value?.[1] === 0x8b;
      stream = new ReadableStream({
        start(ctrl) {
          if (first.value) ctrl.enqueue(first.value);
          if (first.done) ctrl.close();
        },
        async pull(ctrl) {
          const value = await reader.read();
          value.done ? ctrl.close() : ctrl.enqueue(value.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      if (gzip) stream = stream.pipeThrough(new DecompressionStream("gzip"));
      const decoded = stream.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const next = await decoded.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 2 * 1024 * 1024) throw new Error("Sitemap too large");
          chunks.push(next.value);
        }
      } finally {
        await decoded.cancel().catch(() => {});
      }
      return await new Blob(chunks).text();
    } catch {
      incomplete = true;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const robots = await read(new URL("/robots.txt", origin).href);
  for (const match of (robots || "").matchAll(/^sitemap:\s*(\S+)/gim)) {
    const url = sameOrigin(match[1]);
    if (url) queue.push(url);
  }
  while (
    queue.length &&
    visited.size < 8 &&
    urls.length < 500 &&
    !scan.cancelled &&
    Date.now() < deadline
  ) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const content = await read(url);
    if (!content) continue;
    const xml = new DOMParser().parseFromString(content, "application/xml");
    if (xml.querySelector("parsererror")) {
      incomplete = true;
      continue;
    }
    const index = xml.documentElement.localName === "sitemapindex";
    for (const loc of xml.querySelectorAll("loc")) {
      const value = sameOrigin(loc.textContent?.trim());
      if (!value) continue;
      if (index) {
        if (!visited.has(value)) queue.push(value);
      } else if (add(value)) sitemapCount++;
    }
  }
  if (queue.length) incomplete = true;
  if (globalThis.__zuckerExtScan === scan) delete globalThis.__zuckerExtScan;
  return { urls, sitemapCount, incomplete, cancelled: scan.cancelled };
}


export { initPopup, collectSameOriginLinks };
