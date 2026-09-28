// vendored 产物入口：扩展 service worker 里 importScripts("lib/ext-kit.js") 后
// 调 ZuckerExt.init({...}) 完成全部基建装配，业务只提供 capture 实现。
import { initExtension } from './engine';

import { CAPTURE_LIMITS, captureFits, assertCaptureFits, captureBudget, readDevicePixelRatio } from './capture-budget';
import { hidePageCaptureDecorations, showPageCaptureDecorations } from './session';

(globalThis as Record<string, unknown>).ZuckerExt = {
  init: initExtension,
  limits: CAPTURE_LIMITS,
  pageDecorations: { hide: hidePageCaptureDecorations, show: showPageCaptureDecorations },
  captureFits, assertCaptureFits, captureBudget, readDevicePixelRatio,
};
