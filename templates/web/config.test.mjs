import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import tailwind from '@tailwindcss/postcss';
import nextConfig from './next.config.ts';
import postcssConfig from './postcss.config.mjs';

const requireFromTailwind = createRequire(import.meta.resolve('@tailwindcss/postcss'));
const postcss = requireFromTailwind('postcss');

test('web proxy uses the server API base and accepts a configured base with trailing slash', async () => {
  const previousApi = process.env.API_URL;
  try {
    delete process.env.API_URL;
    assert.deepEqual(await nextConfig.rewrites(), [{ source: '/api/:path*', destination: 'http://localhost:4200/api/:path*' }]);
    process.env.API_URL = 'http://127.0.0.1:4310/service/api/';
    assert.deepEqual(await nextConfig.rewrites(), [{ source: '/api/:path*', destination: 'http://127.0.0.1:4310/service/api/:path*' }]);
  } finally {
    if (previousApi === undefined) delete process.env.API_URL;
    else process.env.API_URL = previousApi;
  }
});

test('every route gets baseline security headers that forbid framing and sniffing', async () => {
  const [rule] = await nextConfig.headers();
  assert.equal(rule.source, '/:path*');
  const byKey = Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]));
  assert.match(byKey['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(byKey['Content-Security-Policy'], /object-src 'none'/);
  assert.equal(byKey['X-Frame-Options'], 'DENY');
  assert.equal(byKey['X-Content-Type-Options'], 'nosniff');
  assert.equal(byKey['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('the shipped PostCSS setup applies the existing local Tailwind theme', async () => {
  assert.deepEqual(postcssConfig, { plugins: { '@tailwindcss/postcss': {} } });
  const from = resolve(import.meta.dirname, 'src/app/globals.css');
  const input = await readFile(from, 'utf8');
  const result = await postcss([tailwind({ base: import.meta.dirname, optimize: false })]).process(
    `${input}\n@source inline("bg-surface text-primary-500");\n`,
    { from },
  );
  assert.match(result.css, /\.bg-surface\s*\{/);
  assert.match(result.css, /#0f172a/);
  assert.match(result.css, /\.text-primary-500\s*\{/);
  assert.match(result.css, /#6366f1/);
});
