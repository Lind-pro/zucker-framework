export type {
  CaptureContext,
  BrowserTab,
  DownloadRecord,
  LicenseReply,
  LicenseStatus,
  LicenseStatusOptions,
  DownloadOptions,
  DownloadCheckpoint,
  Downloader,
  ScrollCapture,
  CaptureOutput,
  ExtKitConfig,
  ExtTexts,
  LicensingConfig,
  PopupConfig,
  PopupTexts,
  Settings,
} from './types';
export { initExtension } from './engine';
export { initPopup, collectSameOriginLinks } from './popup';
export { createDownloader } from './download';
export * as scrollCapture from './scroll-capture';
export { CAPTURE_LIMITS, captureFits, assertCaptureFits, captureBudget, readDevicePixelRatio } from './capture-budget';
export { hidePageCaptureDecorations, showPageCaptureDecorations } from './session';
export { createLicensing, type Entitlement, type Licensing } from './licensing';
export {
  buildBatchFileName,
  buildQuickFileName,
  folderNameFor,
  fileStamp,
  hostOf,
  normalizeUrls,
  sanitize,
  sessionStamp,
  todayString,
  urlBaseName,
} from './naming';
