// Explicit targeted browser check. Uses only setContent, synthetic Chrome ports,
// and a disposable Chromium context; never contacts a license/backend service.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { buildSync } = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
function bundle(entry) {
  return buildSync({ entryPoints: [path.join(root, 'src', entry)], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' }).outputFiles[0].text;
}
const scrollSource = bundle('scroll-capture.entry.ts');
const popupSource = bundle('popup.entry.ts');
let browser;
before(async () => {
  const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || (fs.existsSync(localChrome) ? localChrome : undefined) });
});
after(async () => { await browser?.close(); });
async function scrollFixture(virtual = false) {
  const page = await browser.newPage();
  await page.setContent(`<style>body{margin:0}#pane{height:200px;width:600px;overflow:auto}p{height:60px;margin:0}</style><main id="pane" ${virtual ? 'data-virtualized="true"' : ''}>${'<p>Loaded row</p>'.repeat(30)}</main>`);
  const original = await page.evaluate(() => {
    document.getElementById('pane').scrollTop = 100;
    return document.getElementById('pane').outerHTML;
  });
  const cdp = await page.context().newCDPSession(page);
  const vm = require('node:vm');
  const box = { crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout };
  vm.runInNewContext(scrollSource, box);
  const ctx = { options: {}, send: (method, params) => cdp.send(method, params), cleanup: (method, params) => cdp.send(method, params) };
  return { page, original, ctx, capture: box.ZuckerScrollCapture };
}

test('watchdog restores expanded layout and scroll offsets after worker loss', async () => {
  const { page, original, ctx, capture } = await scrollFixture();
  try {
    await page.evaluate(() => {
      const timers = new Map(); let next = 0;
      window.setTimeout = (fn) => { timers.set(++next, fn); return next; };
      window.clearTimeout = (id) => timers.delete(id);
      window.expireLeases = () => { for (const fn of [...timers.values()]) fn(); };
    });
    await capture.prepare(ctx);
    assert.ok(await page.evaluate(() => document.getElementById('pane').clientHeight > 1000));
    await page.evaluate(() => window.expireLeases());
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
    assert.equal(await page.locator('#pane').evaluate((el) => el.scrollTop), 100);
    assert.equal(await page.evaluate(() => !!window.__zuckerScrollCapture), false);
    await capture.restore(ctx); // A delayed worker cleanup is harmless after expiry.
  } finally { await page.close(); }
});

test('virtual lists are rejected rather than claiming a complete capture', async () => {
  const { page, original, ctx, capture } = await scrollFixture(true);
  try {
    await assert.rejects(capture.prepare(ctx), /virtual scrolling list/);
    await capture.restore(ctx);
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
  } finally { await page.close(); }
});

test('restoration uses cleanup rather than an aborted command channel', async () => {
  const { page, original, ctx, capture } = await scrollFixture();
  try {
    const send = ctx.send;
    let count = 0;
    ctx.send = (...args) => { if (++count > 2) throw new Error('Cancelled'); return send(...args); };
    await assert.rejects(capture.prepare(ctx), /Cancelled/);
    await capture.restore(ctx);
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
    assert.equal(await page.locator('#pane').evaluate((el) => el.scrollTop), 100);
  } finally { await page.close(); }
});

test('popup polling preserves URL/numeric drafts; pagehide stops polling', async () => {
  const page = await browser.newPage();
  try {
    const ids = ['urlCount','addUrls','scanSite','queueSummary','queueList','selectAll','selectNone','moreQueueActions','queueMenu','removeUnselected','clearQueue','captureCurrent','start','cancel','progressWrap','progressText','progressCurrent','clearBatch','progressBar','resultList','verifyBanner','verifyText','skipVerify','folderNote','quotaText','proLink','haveCode','licensePanel','licenseCode','activateBtn','deactivateBtn','recheckLicense','licenseHint','status'];
    await page.setContent(`<textarea id="urls"></textarea>${ids.map((id) => `<div id="${id}"></div>`).join('')}<div class="settings"><input id="delay" data-setting type="number" min="0" max="10" value="2"></div>`);
    await page.evaluate(() => {
      window.calls = 0;
      window.data = { fixture_queue: [{ url: 'https://fixture.test/original', selected: true }] };
      window.chrome = {
        storage: { local: { get: async (key) => ({ [key]: window.data[key] }), set: async (value) => Object.assign(window.data, structuredClone(value)) } },
        runtime: { sendMessage: (_message, done) => { window.calls++; queueMicrotask(() => done({ ok: true, batch: { items: [], total: 0 }, quota: { limit: 1, remaining: 1, licenseRefreshing: true } })); } },
      };
    });
    await page.addScriptTag({ content: popupSource });
    await page.evaluate(() => ZuckerExtPopup.init({ messagePrefix: 'FIXTURE', queueKey: 'fixture_queue', settingsKey: 'fixture_settings', quickType: 'CAPTURE_CURRENT', texts: { startNone: 'Start', startSome: (n) => `Start ${n}`, quickIng: 'Working', quickFailed: 'Failed' }, collectSettings: () => ({}), collectQuickSettings: () => ({}), quickResult: () => 'Done' }));
    await page.locator('.queueUrl').click();
    await page.locator('.queueEdit').fill('https://');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.queueEdit').inputValue(), 'https://');
    assert.equal(await page.evaluate(() => window.data.fixture_queue[0].url), 'https://fixture.test/original');
    await page.locator('#delay').fill('3');
    await page.locator('#delay').fill('');
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.data.fixture_settings.delay), '3');
    const calls = await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); return window.calls; });
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.calls), calls);
  } finally { await page.close(); }
});
