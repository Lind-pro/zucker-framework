// Synthetic Chrome ports only; no real license/storage/network operations.
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { buildSync } = require("esbuild");
const bundle = buildSync({ stdin: { contents: `import * as kit from "./src/index.ts"; globalThis.ZuckerExt = { init: kit.initExtension }; globalThis.audit = kit;`, resolveDir: root }, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" }).outputFiles[0].text;
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Fixture did not reach expected state");
}
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}
function harness(app, initial = {}, options = {}) {
  const product = app;
  const store = structuredClone(initial),
    session = structuredClone(options.session || {});
  const log = {
    created: [],
    removed: [],
    downloads: structuredClone(options.downloads || []),
    captures: [],
    commands: [],
    revoked: [],
    requests: [],
    windowsCreated: [],
    windowsRemoved: [],
  };
  const tabs = new Map([
    [
      10,
      {
        id: 10,
        url: "https://fixture.test/current",
        status: "complete",
        windowId: 1,
      },
    ],
  ]);
  const windows = new Map([[1, { id: 1 }]]);
  for (const tab of options.tabs || []) {
    tabs.set(tab.id, structuredClone(tab));
    windows.set(tab.windowId, { id: tab.windowId });
  }
  let nextTab = 20,
    nextWindow = 100,
    messageListener,
    clock = Date.now();
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  function storage(values) {
    return {
      get(keys, cb) {
        if (values === store && options.failLocalGet?.(keys)) {
          queueMicrotask(() => {
            chrome.runtime.lastError = {
              message: "Synthetic storage read failure",
            };
            cb();
            delete chrome.runtime.lastError;
          });
          return;
        }
        const result = {};
        for (const key of typeof keys === "string" ? [keys] : keys)
          if (key in values) result[key] = structuredClone(values[key]);
        queueMicrotask(() => cb(result));
      },
      set(value, cb) {
        if (values === store && options.failLocalSet?.(value)) {
          queueMicrotask(() => {
            chrome.runtime.lastError = { message: "Synthetic storage failure" };
            cb?.();
            delete chrome.runtime.lastError;
          });
          return;
        }
        Object.assign(values, structuredClone(value));
        queueMicrotask(() => cb?.());
      },
      remove(keys, cb) {
        if (values === store && options.failLocalRemove?.(keys)) {
          queueMicrotask(() => {
            chrome.runtime.lastError = {
              message: "Synthetic storage remove failure",
            };
            cb?.();
            delete chrome.runtime.lastError;
          });
          return;
        }
        for (const key of typeof keys === "string" ? [keys] : keys)
          delete values[key];
        queueMicrotask(() => cb?.());
      },
    };
  }
  const changed = event();
  function complete(id, state = "complete") {
    const d = log.downloads.find((d) => d.id === id);
    d.state = state;
    if (state === "interrupted") d.error = "USER_CANCELED";
    changed.emit({ id, state: { current: state } });
  }
  const chrome = {
    storage: { local: storage(store), session: storage(session) },
    runtime: {
      id: "synthetic-extension",
      onInstalled: event(),
      onMessage: {
        addListener(fn) {
          messageListener = fn;
        },
      },
      async sendMessage(msg) {
        if (msg.type === "REVOKE_BLOB_URL") log.revoked.push(msg.url);
        return msg.type === "CREATE_BLOB_URL"
          ? { ok: true, url: `blob:fixture-${log.downloads.length + 1}` }
          : { ok: true };
      },
    },
    downloads: {
      onDeterminingFilename: event(),
      onChanged: changed,
      async download(args) {
        const d = {
          ...args,
          id: log.downloads.length + 1,
          state: "in_progress",
          byExtensionId: chrome.runtime.id,
        };
        log.downloads.push(d);
        if (options.autoComplete !== false)
          queueMicrotask(() => complete(d.id));
        return d.id;
      },
      async search(query) {
        return structuredClone(
          log.downloads.filter((d) =>
            query.id != null
              ? d.id === query.id
              : query.url
                ? new RegExp(query.url).test(d.url)
                : true,
          ),
        );
      },
      async cancel(id) {
        const d = log.downloads.find((d) => d.id === id);
        if (d && d.state === "in_progress") complete(id, "interrupted");
      },
    },
    offscreen: {
      async hasDocument() {
        return true;
      },
      Reason: { BLOBS: "BLOBS" },
    },
    tabs: {
      async get(id) {
        return structuredClone(tabs.get(id));
      },
      async create(args) {
        const t = { id: nextTab++, status: "complete", windowId: 1, ...args };
        tabs.set(t.id, t);
        log.created.push(t);
        return t;
      },
      async remove(id) {
        log.removed.push(id);
        const tab = tabs.get(id);
        tabs.delete(id);
        if (
          tab &&
          ![...tabs.values()].some((other) => other.windowId === tab.windowId)
        ) {
          windows.delete(tab.windowId);
          log.windowsRemoved.push(tab.windowId);
        }
      },
      async update(id, args) {
        Object.assign(tabs.get(id), args);
        // Synthetic page whose load event never fires (a hung subresource).
        if (args.url && options.page?.tabStatus)
          tabs.get(id).status = options.page.tabStatus;
        return tabs.get(id);
      },
    },
    windows: {
      async update() {},
      async create(args) {
        const w = { id: nextWindow++, ...args };
        const t = {
          id: nextTab++,
          status: "complete",
          windowId: w.id,
          url: "about:blank",
        };
        tabs.set(t.id, t);
        w.tabs = [t];
        windows.set(w.id, w);
        log.windowsCreated.push(w);
        return structuredClone({ ...w, tabs: [t] });
      },
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error("No window with id: " + id);
        return structuredClone({ ...w, tabs: undefined });
      },
      async remove(id) {
        windows.delete(id);
        log.windowsRemoved.push(id);
        for (const [tabId, tab] of [...tabs])
          if (tab.windowId === id) tabs.delete(tabId);
      },
    },
    debugger: {
      onEvent: event(),
      attach(t, v, cb) {
        queueMicrotask(cb);
      },
      detach(t, cb) {
        queueMicrotask(cb);
      },
      sendCommand(t, m, p, cb) {
        log.commands.push(m);
        const injected = options.command?.(m, p);
        if (injected?.error) {
          queueMicrotask(() => {
            chrome.runtime.lastError = { message: injected.error };
            cb();
            delete chrome.runtime.lastError;
          });
          return;
        }
        let value = {};
        if (m === "Runtime.evaluate") {
          let result = {};
          if (p.expression.includes("function pageMetrics"))
            result = options.page?.metrics?.() ?? {
              complete: options.page?.complete ?? true,
              loading: false,
              pendingImages: 0,
              fontsPending: false,
              signature: "ready",
            };
          else if (p.expression.includes("function pageReadiness"))
            result = {
              readyState: options.page?.readyState ?? "complete",
              href: tabs.get(t.tabId)?.url,
            };
          else if (p.expression.includes("function pageProbe"))
            result = { error: "", challenge: "" };
          else if (p.expression.includes("bottom:"))
            result = { y: 600, bottom: true };
          else if (p.expression.includes("scrollX")) result = { x: 0, y: 0 };
          value = { result: { value: result } };
        }
        queueMicrotask(() => cb(value));
      },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const sandbox = {
    ZuckerScrollCapture: options.scrollCapture,
    chrome,
    URL,
    Date: Clock,
    Error,
    Promise,
    AbortController,
    crypto: require("node:crypto").webcrypto,
    navigator: {},
    console,
    fetch: async (url, args) => {
      log.requests.push({ url, args });
      return options.fetch
        ? options.fetch(url, args)
        : { ok: true, status: 200, json: async () => ({}) };
    },
    // Short waits are collapsed to ~1ms and advance the mock clock instead. They
    // stay referenced: the code under test parks on them, so unref'ing one lets
    // node:test drain the event loop and cancel the whole run mid-await.
    // Long waits (challenge backoff, the 120s download deadline) keep real
    // timing and stay unreferenced, so they never fire or hold a run open.
    setTimeout(fn, ms) {
      const fast = ms <= 2000;
      const timer = setTimeout(
        () => {
          if (fast) clock += ms;
          fn();
        },
        fast ? 1 : ms,
      );
      if (!fast) timer.unref();
      return timer;
    },
    clearTimeout,
    setInterval(fn, ms) {
      const timer = setInterval(fn, ms);
      timer.unref();
      return timer;
    },
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);
  const config = {
    product,
    brand: product,
    messagePrefix: product.toUpperCase(),
    badgeColor: "#000000",
    defaultSettings: { delayMs: 0 },
    captureScope: options.captureScope,
    beforeQuick: options.beforeQuick,
    afterQuick: options.afterQuick,
    licensing: { apiBase: "https://license.fixture" },
    freeDailyLimit: 30,
    async capture(ctx) {
      log.captures.push(ctx.url);
      if (options.capture) await options.capture(ctx);
      return { base64: "c3ludGhldGlj", mime: "image/png", extension: "png" };
    },
  };
  const { licensePolicy } = require('./license-fixture.cjs');
  vm.runInContext(`globalThis.testLicensePolicy = (${licensePolicy.toString()});`, sandbox);
  config.scrollCapture = options.scrollCapture || { async prepare() {}, async restore() {} };
  config.licensing = sandbox.testLicensePolicy(config.licensing);
  const api = sandbox.audit;
  const audit = { ...api, createLicensing: (namespace, brand, policy) => api.createLicensing(namespace, brand, sandbox.testLicensePolicy(policy)) };
  return {
    chrome,
    store,
    session,
    log,
    product,
    audit,
    api,
    sandbox,
    config,
    complete,
    init() {
      sandbox.ZuckerExt.init(config);
    },
    send(type, extra = {}) {
      return new Promise((resolve) =>
        messageListener(
          { type: `${product.toUpperCase()}_${type}`, ...extra },
          { id: chrome.runtime.id },
          resolve,
        ),
      );
    },
  };
}
module.exports = { harness, defer, until, root };
