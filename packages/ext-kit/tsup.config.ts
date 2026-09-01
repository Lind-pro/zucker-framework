import { defineConfig } from 'tsup';

// vendored iife 产物（ext-kit.js / ext-kit-popup.js）由 build-vendored.mjs 用 esbuild
// 直接构建：tsup 会无条件注入 __name helper，而 collectSameOriginLinks 要经
// chrome.scripting executeScript({func}) 序列化后注入页面执行，页面上下文没有该 helper。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
