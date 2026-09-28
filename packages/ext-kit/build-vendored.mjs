// vendored 产物构建：esbuild 直出，不经 tsup（tsup 注入的 __name helper 会破坏
// chrome.scripting executeScript({func}) 的函数序列化）。
import { build } from 'esbuild';

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
};

await build({ ...shared, entryPoints: ['src/background.entry.ts'], outfile: 'dist/ext-kit.js' });
await build({ ...shared, entryPoints: ['src/popup.entry.ts'], outfile: 'dist/ext-kit-popup.js' });
await build({ ...shared, entryPoints: ['src/scroll-capture.entry.ts'], outfile: 'dist/scroll-capture.js' });
console.log('vendored built: dist/ext-kit.js, dist/ext-kit-popup.js, dist/scroll-capture.js');
