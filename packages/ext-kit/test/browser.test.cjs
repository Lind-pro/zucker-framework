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
async function scrollFixture(virtual = false, content = '<p>Loaded row</p>'.repeat(30), options = {}) {
  const page = await browser.newPage();
  // Image requests to this synthetic host never answer, like a stalled CDN request.
  await page.route('http://stalled.test/**', () => {});
  await page.setContent(`<!doctype html><style>body{margin:0}#pane{height:200px;width:600px;overflow:auto}p{height:60px;margin:0}</style><main id="pane" ${virtual ? 'data-virtualized="true"' : ''}>${content}</main>`, { waitUntil: 'domcontentloaded' });
  const original = await page.evaluate(() => {
    document.getElementById('pane').scrollTop = 100;
    return document.getElementById('pane').outerHTML;
  });
  const cdp = await page.context().newCDPSession(page);
  const vm = require('node:vm');
  const box = { crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout };
  vm.runInNewContext(scrollSource, box);
  const ctx = { options, send: (method, params) => cdp.send(method, params), cleanup: (method, params) => cdp.send(method, params) };
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

test('content sized from the panel height settles instead of growing every pass', async () => {
  const content = `<div style="min-height:100%">${'<p style="height:20px">Row</p>'.repeat(5)}</div><footer id="foot" style="height:40px">Footer</footer>`;
  const { page, original, ctx, capture } = await scrollFixture(false, content);
  try {
    assert.equal(await capture.prepare(ctx), '');
    const layout = await page.evaluate(() => {
      const pane = document.getElementById('pane'), foot = document.getElementById('foot').getBoundingClientRect();
      return { height: pane.getBoundingClientRect().height, footBottom: foot.bottom, overflow: pane.scrollHeight - pane.clientHeight };
    });
    // Original 200px floor is kept, the footer is inside the box, nothing is clipped.
    assert.equal(layout.height, 200);
    assert.ok(layout.footBottom <= layout.height);
    assert.ok(layout.overflow <= 2);
    await capture.restore(ctx);
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
  } finally { await page.close(); }
});

test('self-sized content in a stretched flex panel settles', async () => {
  const content = `<div style="min-height:100%">${'<p style="height:20px">Row</p>'.repeat(5)}</div><footer id="foot" style="height:40px">Footer</footer>`;
  const { page, original, ctx, capture } = await scrollFixture(false, content);
  try {
    // Sidebar + content row: align-items:stretch gives the panel a definite height.
    await page.evaluate(() => {
      const row = document.createElement('div');
      row.id = 'row';
      row.style.cssText = 'display:flex;height:300px';
      row.innerHTML = '<aside style="width:120px">Side</aside>';
      const pane = document.getElementById('pane');
      pane.style.cssText = 'flex:1;height:auto;width:auto';
      pane.before(row); row.append(pane);
    });
    const before = await page.locator('#row').evaluate((el) => el.outerHTML);
    assert.equal(await capture.prepare(ctx), '');
    const overflow = await page.locator('#pane').evaluate((el) => el.scrollHeight - el.clientHeight);
    assert.ok(overflow <= 2);
    await capture.restore(ctx);
    assert.equal(await page.locator('#row').evaluate((el) => el.outerHTML), before);
    void original;
  } finally { await page.close(); }
});

async function layoutFixture(html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(`<!doctype html><style>body{margin:0}p{height:40px;margin:0}</style>${html}`);
  // Compare restoration against the browser's own serialization of the same inline styles.
  const original = await page.evaluate(() => { for (const el of document.querySelectorAll('[style]')) el.setAttribute('style', el.style.cssText); return document.body.outerHTML; });
  const cdp = await page.context().newCDPSession(page);
  const box = { crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout };
  require('node:vm').runInNewContext(scrollSource, box);
  const ctx = { options: {}, send: (method, params) => cdp.send(method, params), cleanup: (method, params) => cdp.send(method, params) };
  return { page, original, ctx, capture: box.ZuckerScrollCapture };
}
const rows = (n) => '<p>Row</p>'.repeat(n);
const selfSizedLayouts = {
  // Sidebar + top bar admin shell: the panel is flexed inside a stretched column.
  'admin shell': `<div style="display:flex;height:100vh"><div style="width:220px">Menu</div><div style="flex:1;display:flex;flex-direction:column;min-width:0"><div style="height:64px">Top</div><div id="pane" style="flex:1;overflow:auto;padding:24px"><div style="min-height:100%">${rows(25)}</div><footer id="foot" style="height:60px">Footer</footer></div></div></div>`,
  // A percentage footer grows by a different amount on every pass.
  'percentage footer': `<div style="display:flex;height:100vh"><aside style="width:200px">Side</aside><main id="pane" style="flex:1;overflow:auto"><div style="min-height:100%">${rows(8)}</div><footer id="foot" style="height:10%">Footer</footer></main></div>`,
  // Absolutely positioned content does not contribute to an auto height.
  'absolute overflow': `<div style="display:flex;height:100vh"><aside style="width:200px">Side</aside><main id="pane" style="flex:1;overflow:auto;position:relative"><div style="min-height:100%">${rows(8)}</div><footer id="foot" style="height:60px">Footer</footer><div style="position:absolute;top:1200px;height:120px;width:200px">Tip</div></main></div>`,
};
for (const [name, html] of Object.entries(selfSizedLayouts))
  test(`self-sized content settles in a ${name}`, async () => {
    const { page, original, ctx, capture } = await layoutFixture(html);
    try {
      assert.equal(await capture.prepare(ctx), '');
      const layout = await page.evaluate(() => {
        const pane = document.getElementById('pane');
        return { overflow: pane.scrollHeight - pane.clientHeight, footer: document.getElementById('foot').getBoundingClientRect().bottom, bottom: pane.getBoundingClientRect().bottom };
      });
      assert.ok(layout.overflow <= 2, `clipped ${layout.overflow}px`);
      assert.ok(layout.footer <= layout.bottom + 1);
      await capture.restore(ctx);
      assert.equal(await page.evaluate(() => document.body.outerHTML), original);
    } finally { await page.close(); }
  });

test('page changes outside the expanded panels do not block settling', async () => {
  const { page, ctx, capture } = await layoutFixture(`<div style="display:flex;flex-direction:column;height:100vh"><div id="banner" style="height:80px">Banner</div><main id="pane" style="flex:1;min-height:0;overflow:auto">${rows(40)}</main></div>`);
  try {
    await page.evaluate(() => { let tall = false; window.banner = setInterval(() => { document.getElementById('banner').style.height = (tall = !tall) ? '120px' : '80px'; }, 200); });
    assert.equal(await capture.prepare(ctx), '');
    await capture.restore(ctx);
  } finally { await page.evaluate(() => clearInterval(window.banner)); await page.close(); }
});

test('a stalled tracking pixel does not delay settling', async () => {
  const content = `${'<p>Loaded row</p>'.repeat(30)}<img src="http://stalled.test/pixel.gif" width="1" height="1">`;
  const { page, ctx, capture } = await scrollFixture(false, content);
  try {
    const started = Date.now();
    assert.equal(await capture.prepare(ctx), '');
    assert.ok(Date.now() - started < 6000);
    await capture.restore(ctx);
  } finally { await page.close(); }
});

test('a stalled content image is captured with a warning instead of failing', async () => {
  const content = `${'<p>Loaded row</p>'.repeat(30)}<img src="http://stalled.test/photo.png" width="200" height="120">`;
  const { page, original, ctx, capture } = await scrollFixture(false, content);
  try {
    assert.match(await capture.prepare(ctx), /images in scrolling areas/);
    await capture.restore(ctx);
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
  } finally { await page.close(); }
});

test('allowUnstable captures still-changing scrolling content with a warning', async () => {
  const content = `${'<p>Loaded row</p>'.repeat(10)}<div id="ticker" style="height:40px"></div>`;
  const { page, original, ctx, capture } = await scrollFixture(false, content, { allowUnstable: true });
  try {
    await page.evaluate(() => {
      // Start growing only once the pane is expanded, so the scroll phase
      // completes and the settle phase never sees two identical measurements.
      const sheet = document.head.appendChild(document.createElement('style'));
      let extra = 0;
      const timer = setInterval(() => {
        if (document.getElementById('pane').clientHeight <= 200) return;
        sheet.textContent = `#ticker{min-height:${40 + (extra += 7)}px}`;
      }, 60);
      window.stopTicker = () => { clearInterval(timer); sheet.remove(); };
    });
    assert.match(await capture.prepare(ctx), /still changing/);
    await capture.restore(ctx);
    await page.evaluate(() => window.stopTicker());
    assert.equal(await page.locator('#pane').evaluate((el) => el.outerHTML), original);
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
