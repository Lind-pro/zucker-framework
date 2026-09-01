// vendored 产物入口：扩展 service worker 里 importScripts("lib/ext-kit.js") 后
// 调 ZuckerExt.init({...}) 完成全部基建装配，业务只提供 capture 实现。
import { initExtension } from './engine';

(globalThis as Record<string, unknown>).ZuckerExt = { init: initExtension };
