// Synthetic policy adapter exercises generic licensing lifecycle.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, defer, until } = require("./harness.cjs");
const apps = ["fixture-export"];
const token = "synthetic-license-token";
const entitlement = () => ({
  active: true,
  plan: "pro",
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
});
function paidStore(product, age = 0) {
  return {
    [`${product}_license_token`]: token,
    [`${product}_device_id`]: "synthetic-device",
    [`${product}_entitlement`]: {
      ...entitlement(),
      checkedAt: Date.now() - age,
    },
    [`${product}_free_usage`]: {
      date: new Date().toLocaleDateString("en-CA"),
      used: 30,
    },
  };
}
const reply = (payload, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => payload,
});
const authorized = () => reply({ result: { entitlement: entitlement() } });
async function done(h) {
  await until(async () => !(await h.send("STATE")).batch.busy);
  return h.send("STATE");
}
for (const app of apps) {
  const product = app;
  test(`${app}: a rejected Pro license cannot survive a cache removal failure`, async () => {
    for (const failMarkerWrite of [false, true]) {
      let mode = "denied";
      const h = harness(app, paidStore(product), {
        failLocalRemove: (keys) => keys === `${product}_entitlement`,
        failLocalSet: (value) =>
          failMarkerWrite && value[`${product}_entitlement`]?.active === false,
        fetch: async () =>
          mode === "allowed"
            ? authorized()
            : mode === "offline"
              ? reply(null, 503)
              : reply(
                  {
                    status: 403,
                    result: null,
                    message: "Synthetic revoked license",
                    timestamp: Date.now(),
                  },
                  403,
                ),
      });
      h.init();
      assert.equal((await h.send("REFRESH_LICENSE")).quota.pro, false);
      assert.equal((await h.send("STATE")).quota.pro, false);
      assert.equal((await h.send("CAPTURE_CURRENT", { tabId: 10 })).ok, false);
      assert.equal(h.log.downloads.length, 0);
      mode = "offline";
      assert.equal((await h.send("REFRESH_LICENSE")).quota.pro, false);
      mode = "allowed";
      assert.equal((await h.send("REFRESH_LICENSE")).quota.pro, true);
    }
  });
  test(`${app}: Pro ignores exhausted free usage for quick and 40-page batch exports`, async () => {
    const h = harness(app, paidStore(product));
    h.init();
    const quick = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(quick.ok, true, quick.error);
    assert.equal(quick.quota.pro, true);
    assert.equal(quick.quota.remaining, null);
    assert.equal(quick.quota.limit, null);
    const started = await h.send("START", {
      urls: Array.from(
        { length: 40 },
        (_, n) => `https://fixture.test/page-${n}`,
      ),
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.batch.total, 40);
    const result = await done(h);
    assert.equal(result.batch.success, 40);
    assert.equal(h.log.downloads.length, 41);
    assert.equal(h.store[`${product}_free_usage`].used, 30);
  });
  test(`${app}: refreshing an old Pro cache never reports free quota while pending`, async () => {
    const gate = defer();
    const h = harness(app, paidStore(product, 4 * 86400000), {
      fetch: () => gate.promise,
    });
    h.init();
    const pending = await h.send("STATE");
    assert.equal(pending.quota.licenseStatus, "checking");
    assert.equal(pending.quota.limit, null);
    const quick = h.send("CAPTURE_CURRENT", { tabId: 10 });
    gate.resolve(authorized());
    assert.equal((await quick).ok, true);
    assert.equal((await h.send("STATE")).quota.pro, true);
    assert.equal(h.log.requests.length, 1);
    assert.equal(h.store[`${product}_free_usage`].used, 30);
  });
  test(`${app}: a gateway 403 keeps cached Pro and its activation credentials`, async () => {
    const h = harness(app, paidStore(product, 13 * 3600000), {
      fetch: async () => reply(null, 403),
    });
    h.init();
    const result = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.quota.pro, true);
    assert.equal(h.store[`${product}_license_token`], token);
    assert.equal(h.store[`${product}_device_id`], "synthetic-device");
    assert.equal(h.store[`${product}_entitlement`].plan, "pro");
  });
  test(`${app}: unverifiable saved Pro is not charged as free and can recover immediately`, async () => {
    let reachable = false;
    const h = harness(app, paidStore(product, 4 * 86400000), {
      fetch: async () => (reachable ? authorized() : reply(null, 503)),
    });
    h.init();
    const result = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(result.ok, false);
    assert.match(result.error, /verify.*Pro license/);
    assert.doesNotMatch(result.error, /Daily free limit/);
    const state = await h.send("STATE");
    assert.equal(state.quota.licenseStatus, "unavailable");
    assert.equal(state.quota.limit, null);
    assert.equal(h.store[`${product}_license_token`], token);
    assert.equal(h.log.downloads.length, 0);
    reachable = true;
    assert.equal((await h.send("REFRESH_LICENSE")).quota.pro, true);
    assert.equal((await h.send("CAPTURE_CURRENT", { tabId: 10 })).ok, true);
    assert.equal(h.store[`${product}_free_usage`].used, 30);
  });
  test(`${app}: genuine rejection stops Pro without deleting its recoverable token`, async () => {
    for (const status of [401, 403]) {
      const h = harness(app, paidStore(product, 13 * 3600000), {
        fetch: async () =>
          reply(
            {
              status,
              result: null,
              message: "Synthetic rejected license",
              timestamp: Date.now(),
            },
            status,
          ),
      });
      h.init();
      const result = await h.send("CAPTURE_CURRENT", { tabId: 10 });
      assert.equal(result.ok, false);
      assert.doesNotMatch(result.error, /Daily free limit/);
      const state = await h.send("STATE");
      assert.equal(state.quota.licenseStatus, "invalid");
      assert.equal(state.quota.pro, false);
      assert.equal(h.store[`${product}_license_token`], token);
      assert.equal(h.store[`${product}_entitlement`], undefined);
      assert.equal(h.log.downloads.length, 0);
    }
  });
  test(`${app}: inactive or expired server entitlement cannot reuse a cached Pro grant`, async () => {
    for (const value of [
      { ...entitlement(), active: false },
      { ...entitlement(), plan: "free" },
      {
        ...entitlement(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]) {
      const h = harness(app, paidStore(product, 13 * 3600000), {
        fetch: async () => reply({ result: { entitlement: value } }),
      });
      h.init();
      const result = await h.send("REFRESH_LICENSE");
      assert.equal(result.quota.pro, false);
      assert.equal(result.quota.licenseStatus, "invalid");
    }
  });
  test(`${app}: a stale failed refresh cannot erase a newly restored activation`, async () => {
    const gate = defer();
    const h = harness(app, paidStore(product, 4 * 86400000), {
      fetch: async (url) =>
        url.endsWith("/activate")
          ? reply({
              result: { token: "restored-token", entitlement: entitlement() },
            })
          : gate.promise,
    });
    const licensing = h.audit.createLicensing(product, product, {
      apiBase: "https://license.fixture",
    });
    const pending = licensing.getStatus();
    await until(() => h.log.requests.length === 1);
    await licensing.activate("SYNTHETIC-CODE");
    gate.resolve(
      reply(
        {
          status: 403,
          result: null,
          message: "Synthetic rejected license",
          timestamp: Date.now(),
        },
        403,
      ),
    );
    assert.equal((await pending).state, "pro");
    assert.equal(h.store[`${product}_license_token`], "restored-token");
    assert.equal((await licensing.getStatus()).state, "pro");
  });
  test(`${app}: an unactivated exhausted installation offers restoration without granting Pro`, async () => {
    const initial = paidStore(product);
    delete initial[`${product}_license_token`];
    delete initial[`${product}_entitlement`];
    const h = harness(app, initial);
    h.init();
    const result = await h.send("CAPTURE_CURRENT", { tabId: 10 });
    assert.equal(result.ok, false);
    assert.match(result.error, /original activation code/);
    assert.equal((await h.send("STATE")).quota.licenseStatus, "free");
    assert.equal(h.log.downloads.length, 0);
  });
}
