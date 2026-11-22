// Recovery contracts extracted from two mature consumers; domain-format policy stays there.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, defer, until } = require("./harness.cjs");
const apps = ["fixture-export"];
const url = "https://fixture.test/a";
async function done(h) {
  await until(async () => !(await h.send("STATE")).batch.busy);
  return h.send("STATE");
}
for (const app of apps) {
  test(`${app}: restores the original scroll position captured before viewport preparation`, async () => {
    let resized = false,
      restoredY;
    const h = harness(
      app,
      {},
      {
        beforeQuick: async () => {
          resized = true;
        },
        afterQuick: async () => {
          resized = false;
        },
      },
    );
    const send = h.chrome.debugger.sendCommand;
    h.chrome.debugger.sendCommand = (target, method, params, callback) => {
      if (
        method === "Runtime.evaluate" &&
        params.expression.includes("window.scrollX")
      ) {
        queueMicrotask(() =>
          callback({ result: { value: { x: 0, y: resized ? 0 : 900 } } }),
        );
        return;
      }
      if (
        method === "Runtime.evaluate" &&
        params.expression.includes("window.scrollTo")
      ) {
        require("node:vm").runInNewContext(params.expression, {
          window: {
            scrollTo: (x, y) => {
              restoredY = typeof x === "object" ? x.top : y;
            },
          },
        });
      }
      send(target, method, params, callback);
    };
    h.init();
    assert.equal((await h.send("CAPTURE_CURRENT", { tabId: 10 })).ok, true);
    assert.equal(restoredY, 900);
  });
  test(`${app}: a navigation during full-page preparation discards the export`, async () => {
    const h = harness(
      app,
      {},
      {
        scrollCapture: {
          async prepare() {
            await h.chrome.tabs.update(10, {
              url: "https://different.fixture/private",
            });
          },
          async restore() {},
        },
      },
    );
    h.init();
    const result = await h.send("CAPTURE_CURRENT", {
      tabId: 10,
      settings: { captureArea: "full" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /page changed/i);
    assert.equal(h.log.downloads.length, 0);
    assert.equal(h.log.captures.length, 0);
  });
  test(`${app}: a navigation during output rendering discards the result`, async () => {
    const h = harness(
      app,
      {},
      {
        capture: async () =>
          h.chrome.tabs.update(10, {
            url: "https://different.fixture/private",
          }),
      },
    );
    h.init();
    const result = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(result.ok, false);
    assert.equal(h.log.downloads.length, 0);
    assert.equal((await h.send("STATE")).quota.used, 0);
  });
  test(`${app}: failed full capture restores expanded scroll areas; viewport capture leaves them alone`, async () => {
    const events = [];
    const h = harness(
      app,
      {},
      {
        scrollCapture: {
          async prepare() {
            events.push("expand");
          },
          async restore() {
            events.push("restore");
          },
        },
        captureScope: (options) => options.captureArea,
        capture: async () => {
          events.push("capture");
          throw Error("Synthetic capture failure");
        },
      },
    );
    h.init();
    assert.equal(
      (
        await h.send("CAPTURE_CURRENT", {
          tabId: 10,
          settings: { captureArea: "full" },
        })
      ).ok,
      false,
    );
    assert.deepEqual(events, ["expand", "capture", "restore"]);
    events.length = 0;
    assert.equal(
      (
        await h.send("CAPTURE_CURRENT", {
          tabId: 10,
          settings: { captureArea: "viewport" },
        })
      ).ok,
      false,
    );
    assert.deepEqual(events, ["capture"]);
    assert.equal(h.log.downloads.length, 0);
    assert.equal((await h.send("STATE")).quota.used, 0);
  });
  test(`${app}: batch pages load in a dedicated window that is cleaned up`, async () => {
    const h = harness(app);
    h.init();
    assert.equal(
      (await h.send("START", { urls: [url, "https://fixture.test/b"] })).ok,
      true,
    );
    const state = await done(h);
    assert.equal(state.batch.success, 2);
    // One window for the whole batch, never the window the user is working in.
    assert.equal(h.log.windowsCreated.length, 1);
    const batchWindow = h.log.windowsCreated[0].id;
    assert.equal(h.log.windowsCreated[0].focused, false);
    assert.equal(h.log.created.length, 2);
    for (const tab of h.log.created) assert.equal(tab.windowId, batchWindow);
    // Both capture tabs and the window itself are closed when the batch ends.
    assert.equal(h.log.removed.length, 3); // Two capture tabs and our idle tab.
    assert.deepEqual(h.log.windowsRemoved, [batchWindow]);
  });
  test(`${app}: batch cleanup preserves user tabs and a navigated idle tab`, async () => {
    for (const navigateIdle of [false, true]) {
      let userTab;
      const h = harness(
        app,
        {},
        {
          async capture() {
            const window = h.log.windowsCreated[0];
            userTab = navigateIdle
              ? await h.chrome.tabs.update(window.tabs[0].id, {
                  url: "https://fixture.test/notes",
                })
              : await h.chrome.tabs.create({
                  windowId: window.id,
                  url: "https://fixture.test/notes",
                });
          },
        },
      );
      h.init();
      await h.send("START", { urls: [url] });
      assert.equal((await done(h)).batch.success, 1);
      assert.equal(
        (await h.chrome.tabs.get(userTab.id)).url,
        "https://fixture.test/notes",
      );
      assert.deepEqual(h.log.windowsRemoved, []);
      assert.equal(h.session[`${app}_owned_tab`], undefined);
    }
  });
  test(`${app}: worker recovery closes only session-owned tabs`, async () => {
    const h = harness(
      app,
      {},
      {
        session: {
          [`${app}_owned_tab`]: { tabId: 71, idleTabId: 70, windowId: 7 },
        },
        tabs: [
          { id: 70, windowId: 7, url: "about:blank" },
          { id: 71, windowId: 7, url },
          { id: 72, windowId: 7, url: "https://fixture.test/notes" },
        ],
      },
    );
    h.init();
    await h.send("STATE");
    assert.deepEqual(h.log.removed, [71, 70]);
    assert.equal(
      (await h.chrome.tabs.get(72)).url,
      "https://fixture.test/notes",
    );
    assert.deepEqual(h.log.windowsRemoved, []);
  });
  test(`${app}: a mid-batch quota failure explains itself on every remaining row`, async () => {
    const h = harness(
      app,
      {
        [`${app}_free_usage`]: {
          // Local calendar date, like the product's todayString(); UTC broke this test before 09:00 JST.
          date: new Date().toLocaleDateString('sv-SE'),
          used: 27,
        },
      },
      {
        async capture() {
          // Another completion consumes the remaining quota after START accepts
          // all three URLs, so this exercises the loop's quota check, not slicing.
          h.store[`${app}_free_usage`].used = 29;
        },
      },
    );
    h.init();
    assert.equal(
      (
        await h.send("START", {
          urls: [url, "https://fixture.test/b", "https://fixture.test/c"],
        })
      ).ok,
      true,
    );
    const state = await done(h);
    assert.equal(state.batch.total, 3);
    assert.equal(state.batch.success, 1);
    assert.equal(state.batch.failed, 2);
    for (const item of state.batch.items.slice(1)) {
      assert.equal(item.status, "failed");
      assert.match(item.error, /Daily free limit reached/);
    }
  });
  test(`${app}: Clear reconciles a completed download before deleting its checkpoint`, async () => {
    let fail = true;
    const h = harness(
      app,
      {},
      {
        failLocalSet(value) {
          if (fail && value[`${app}_free_usage`]) {
            fail = false;
            return true;
          }
          return false;
        },
      },
    );
    h.init();
    await h.send("START", { urls: [url] });
    assert.equal((await done(h)).batch.stalled, true);
    const cleared = await h.send("CLEAR_BATCH");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.batch.busy, false);
    assert.equal(cleared.batch.total, 0);
    assert.equal(cleared.quota.used, 1);
    assert.equal(h.store[`${app}_batch_state`], undefined);
    assert.equal((await h.send("CLEAR_BATCH")).quota.used, 1);
  });
  test(`${app}: failed reconciliation or removal keeps results retryable`, async () => {
    let failCharge = true,
      failRemove = false;
    const h = harness(
      app,
      {},
      {
        failLocalSet: (value) =>
          failCharge && Boolean(value[`${app}_free_usage`]),
        failLocalRemove: () => failRemove,
      },
    );
    h.init();
    await h.send("START", { urls: [url] });
    await done(h);
    assert.equal((await h.send("CLEAR_BATCH")).ok, false);
    assert.equal((await h.send("STATE")).batch.stalled, true);
    assert.equal(h.store[`${app}_batch_state`].items[0].status, "downloading");
    failCharge = false;
    failRemove = true;
    assert.equal((await h.send("CLEAR_BATCH")).ok, false);
    assert.equal((await h.send("STATE")).batch.success, 1);
    assert.equal(h.store[`${app}_free_usage`].used, 1);
    failRemove = false;
    assert.equal((await h.send("CLEAR_BATCH")).quota.used, 1);
  });
  test(`${app}: a failed quota read cannot turn an uncharged download into a clearable success`, async () => {
    let failRead = true;
    const h = harness(
      app,
      {},
      {
        failLocalGet(key) {
          if (
            failRead &&
            key === `${app}_free_usage` &&
            h.log.downloads.some((item) => item.state === "complete")
          ) {
            failRead = false;
            return true;
          }
          return false;
        },
      },
    );
    h.init();
    await h.send("START", { urls: [url] });
    await until(() => !failRead);
    assert.equal((await done(h)).batch.stalled, true);
    failRead = true;
    assert.equal((await h.send("CLEAR_BATCH")).ok, false);
    assert.equal(h.store[`${app}_batch_state`].items[0].status, "downloading");
    assert.equal((await h.send("CLEAR_BATCH")).quota.used, 1);
  });
  test(`${app}: Clear holds the capture lock while reconciling downloads`, async () => {
    let fail = true;
    const h = harness(
      app,
      {},
      {
        failLocalSet(value) {
          if (fail && value[`${app}_free_usage`]) {
            fail = false;
            return true;
          }
          return false;
        },
      },
    );
    h.init();
    await h.send("START", { urls: [url] });
    await done(h);
    const gate = defer(),
      entered = defer();
    const search = h.chrome.downloads.search;
    h.chrome.downloads.search = async (query) => {
      entered.resolve();
      await gate.promise;
      return search(query);
    };
    const clearing = h.send("CLEAR_BATCH");
    await entered.promise;
    assert.equal((await h.send("START", { urls: [url] })).ok, false);
    assert.equal((await h.send("CLEAR_BATCH")).ok, false);
    gate.resolve();
    assert.equal((await clearing).quota.used, 1);
  });
  test(`${app}: completion write failure retains a checkpoint and cannot double charge`, async () => {
    const product = app;
    let fail = true;
    const h = harness(
      app,
      {},
      {
        failLocalSet(value) {
          if (fail && value[`${product}_free_usage`]) {
            fail = false;
            return true;
          }
          return false;
        },
      },
    );
    h.init();
    await h.send("START", { urls: [url] });
    const state = await done(h);
    assert.equal(state.batch.running, true);
    assert.equal(state.quota.used, 0);
    assert.equal((await h.send("START", { urls: [url] })).ok, false);
    const restarted = harness(app, h.store, { downloads: h.log.downloads });
    restarted.init();
    const recovered = await done(restarted);
    assert.equal(recovered.batch.success, 1);
    assert.equal(recovered.quota.used, 1);
    assert.equal(restarted.log.captures.length, 0);
  });
  test(`${app}: quick capture reconciles its prior completed file before starting again`, async () => {
    const product = app;
    let fail = true;
    const h = harness(
      app,
      {},
      {
        failLocalSet(value) {
          if (fail && value[`${product}_free_usage`]) {
            fail = false;
            return true;
          }
          return false;
        },
      },
    );
    h.init();
    const first = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(first.ok, false);
    const second = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(second.ok, true);
    assert.equal(second.quota.used, 2);
    assert.equal(h.log.downloads.length, 2);
  });
  test(`${app}: preserves distinct hash routes and rejects non-web URLs`, () => {
    const h = harness(app);
    assert.deepEqual(
      Array.from(
        h.audit.normalizeUrls([
          url + "#/orders",
          url + "#/customers",
          url + "#/orders",
          "javascript:alert(1)",
        ]),
      ),
      [url + "#/orders", url + "#/customers"],
    );
  });
  test(`${app}: waits for download completion before counting/charging`, async () => {
    const h = harness(app, {}, { autoComplete: false });
    h.init();
    assert.equal((await h.send("START", { urls: [url] })).ok, true);
    await until(() => h.log.downloads.length === 1);
    let state = await h.send("STATE");
    assert.equal(state.batch.success, 0);
    assert.equal(state.quota.used, 0);
    h.complete(1);
    state = await done(h);
    assert.equal(state.batch.success, 1);
    assert.equal(state.quota.used, 1);
    assert.equal(h.log.revoked.length, 1);
  });
  test(`${app}: interrupted downloads fail without consuming quota`, async () => {
    const h = harness(app, {}, { autoComplete: false });
    h.init();
    await h.send("START", { urls: [url] });
    await until(() => h.log.downloads.length === 1);
    h.complete(1, "interrupted");
    const state = await done(h);
    assert.equal(state.batch.success, 0);
    assert.equal(state.quota.used, 0);
  });
  test(`${app}: cancelling during capture produces no file or charge`, async () => {
    const gate = defer();
    const h = harness(app, {}, { capture: () => gate.promise });
    h.init();
    await h.send("START", { urls: [url] });
    await until(() => h.log.captures.length === 1);
    await h.send("CANCEL");
    gate.resolve();
    const state = await done(h);
    assert.equal(state.batch.current, "Stopped");
    assert.equal(state.batch.cancelled, 1);
    assert.equal(h.log.downloads.length, 0);
    assert.equal(state.quota.used, 0);
  });
  test(`${app}: cancelling a pending download cancels Chrome's download`, async () => {
    const h = harness(app, {}, { autoComplete: false });
    h.init();
    await h.send("START", { urls: [url] });
    await until(() => h.log.downloads.length === 1);
    await h.send("CANCEL");
    const state = await done(h);
    assert.equal(h.log.downloads[0].state, "interrupted");
    assert.equal(state.quota.used, 0);
  });
  test(`${app}: only one concurrent start is accepted, including quick capture`, async () => {
    const gate = defer();
    const h = harness(app, {}, { capture: () => gate.promise });
    h.init();
    const responses = await Promise.all([
      h.send("START", { urls: [url] }),
      h.send("START", { urls: [url + "b"] }),
      h.send("CAPTURE_CURRENT", { tabId: 10 }),
    ]);
    assert.equal(responses.filter((r) => r.ok).length, 1);
    await until(() => h.log.captures.length === 1);
    assert.equal((await h.send("STATE")).batch.busy, true);
    gate.resolve();
    const state = await done(h);
    assert.deepEqual(h.log.captures, [url]);
    assert.equal(state.batch.success, 1);
  });
  test(`${app}: upgrade event preserves an active batch`, async () => {
    const gate = defer();
    const h = harness(app, {}, { capture: () => gate.promise });
    h.init();
    await h.send("START", { urls: [url, url + "b"] });
    await until(() => h.log.captures.length === 1);
    h.chrome.runtime.onInstalled.emit({ reason: "update" });
    assert.equal((await h.send("STATE")).batch.total, 2);
    gate.resolve();
    const state = await done(h);
    assert.equal(state.batch.success, 2);
    assert.ok(h.log.downloads.every((d) => !d.filename.startsWith("/")));
  });
  test(`${app}: restore honors the persisted stop and closes only the session-owned tab`, async () => {
    const product = app;
    const h = harness(
      app,
      {
        [`${product}_batch_state`]: {
          running: true,
          cancelRequested: true,
          items: [{ url, status: "running" }],
        },
      },
      { session: { [`${product}_owned_tab`]: { tabId: 99 } } },
    );
    h.init();
    const state = await done(h);
    assert.equal(state.batch.current, "Stopped");
    assert.equal(h.log.created.length, 0);
    assert.deepEqual(h.log.removed, [99]);
  });
  test(`${app}: restored completed download is counted once without recapture`, async () => {
    const product = app;
    const initial = {
      [`${product}_batch_state`]: {
        running: true,
        pro: false,
        folder: "fixture/session",
        items: [
          {
            url,
            status: "downloading",
            fileName: "fixture/a.png",
            downloadId: 1,
            downloadUrl: "blob:fixture",
            chargeFree: true,
          },
        ],
      },
    };
    const downloads = [
      {
        id: 1,
        url: "blob:fixture",
        state: "complete",
        byExtensionId: "synthetic-extension",
      },
    ];
    const h = harness(app, initial, { downloads });
    h.init();
    const state = await done(h);
    assert.equal(state.batch.success, 1);
    assert.equal(state.quota.used, 1);
    assert.equal(h.log.created.length, 0);
    const next = harness(app, h.store, { downloads });
    next.init();
    const restored = await done(next);
    assert.equal(restored.quota.used, 1);
  });
  test(`${app}: restore cannot claim another extension's download`, async () => {
    const product = app;
    const h = harness(
      app,
      {
        [`${product}_batch_state`]: {
          running: true,
          items: [{ url, status: "downloading", downloadId: 1 }],
        },
      },
      {
        downloads: [
          { id: 1, state: "complete", byExtensionId: "other-extension" },
        ],
      },
    );
    h.init();
    const state = await done(h);
    assert.equal(state.batch.failed, 1);
    assert.equal(state.quota.used, 0);
  });
  test(`${app}: malformed entitlement never upgrades to Pro`, async () => {
    const product = app;
    const h = harness(app, { [`${product}_license_token`]: "synthetic-token" });
    const license = h.audit.createLicensing(product, product, {
      apiBase: "https://license.fixture",
    });
    assert.equal(await license.getEntitlement(), null);
    assert.equal(await license.getEntitlement(), null);
  });
  test(`${app}: stale refresh is shared and status can use bounded valid cache`, async () => {
    const product = app;
    const gate = defer();
    const entitlement = {
      active: true,
      plan: "pro",
      checkedAt: Date.now() - 13 * 3600000,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const h = harness(
      app,
      {
        [`${product}_license_token`]: "synthetic-token",
        [`${product}_entitlement`]: entitlement,
      },
      { fetch: () => gate.promise },
    );
    const license = h.audit.createLicensing(product, product, {
      apiBase: "https://license.fixture",
    });
    const queries = [license.getEntitlement(), license.getEntitlement()];
    assert.equal(
      (await license.getEntitlement({ cachedOnly: true })).plan,
      "pro",
    );
    assert.equal(h.log.requests.length, 1);
    gate.resolve({ ok: false, status: 503, json: async () => ({}) });
    await Promise.all(queries);
  });
  test(`${app}: deactivate releases remotely and keeps local credentials on failure`, async () => {
    const product = app;
    let succeeds = false;
    const h = harness(
      app,
      { [`${product}_license_token`]: "synthetic-token" },
      {
        fetch: async () => ({
          ok: succeeds,
          status: succeeds ? 200 : 503,
          json: async () => ({ result: { deactivated: true } }),
        }),
      },
    );
    const license = h.audit.createLicensing(product, product, {
      apiBase: "https://license.fixture",
    });
    await assert.rejects(license.deactivate(), /Could not release/);
    assert.equal(h.store[`${product}_license_token`], "synthetic-token");
    succeeds = true;
    await license.deactivate();
    assert.equal(h.store[`${product}_license_token`], undefined);
    assert.ok(h.log.requests.every((r) => r.url.endsWith("/deactivate")));
  });
}
