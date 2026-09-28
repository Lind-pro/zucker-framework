export type Settings = Record<string, unknown>;
/** Structural browser ports keep public declarations independent of @types/chrome. */
export interface BrowserTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  windowId: number;
  title?: string;
  width?: number;
  height?: number;
  active: boolean;
}
export interface DownloadRecord {
  id: number;
  url: string;
  finalUrl?: string;
  filename: string;
  state: 'in_progress' | 'interrupted' | 'complete';
  error?: string;
  byExtensionId?: string;
}
export interface CaptureContext {
  mode: 'batch' | 'quick';
  tabId: number;
  url: string;
  options: Settings;
  /** Capture commands reject on cancellation. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Restoration MUST remain usable after Stop/abort. */
  cleanup(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface CaptureOutput {
  base64: string;
  mime: string;
  extension: string;
  warning?: string;
}
export interface Entitlement {
  expiresAt: string;
  [key: string]: unknown;
}
export interface LicenseReply {
  accepted: boolean;
  /** Authoritative server rejection, NOT a proxy/network error. */
  denied?: boolean;
  entitlement?: unknown;
  token?: string;
  deactivated?: boolean;
}
export interface LicensingConfig {
  purchaseUrl?: string;
  cacheTtlMs: number;
  offlineGraceMs: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  /** Consumer owns transport, endpoints, code normalization and envelope validation. */
  request(operation: 'activate' | 'me' | 'deactivate', input: {
    code?: string; deviceId?: string; brand?: string; token?: string;
  }, signal: AbortSignal): Promise<LicenseReply>;
  /** Validate the consumer's actual grant/plan. The kit additionally checks expiry. */
  normalizeEntitlement(value: unknown): Entitlement | null;
}
export interface LicenseStatus {
  state: 'free' | 'checking' | 'pro' | 'invalid' | 'unavailable';
  entitlement?: Entitlement;
  message?: string;
  refreshing?: boolean;
}
export interface LicenseStatusOptions { cachedOnly?: boolean; force?: boolean }
export interface Licensing {
  activate(code: string): Promise<Entitlement>;
  getEntitlement(options?: LicenseStatusOptions): Promise<Entitlement | null>;
  getStatus(options?: LicenseStatusOptions): Promise<LicenseStatus>;
  /** Releases the device remotely before deleting local identity. */
  deactivate(): Promise<void>;
  purchaseUrl?: string;
}
export interface DownloadOptions {
  deadlineMs?: number;
  /** Must exceed deadlineMs; offscreen reclaims URLs if the worker disappears. */
  blobLeaseMs?: number;
  pollMs?: number;
  offscreenUrl?: string;
}
export interface DownloadCheckpoint { downloadId?: number; downloadUrl?: string }
export interface Downloader {
  downloadViaBlob(base64: string, mime: string, filename: string, options?: {
    signal?: AbortSignal;
    onPrepared?(url: string): Promise<void>;
    onCreated?(id: number): Promise<void>;
  }): Promise<number>;
  recover(item: DownloadCheckpoint, signal?: AbortSignal): Promise<DownloadRecord>;
}
export interface ScrollCapture {
  prepare(ctx: CaptureContext, waitForContent?: () => Promise<void>): Promise<void>;
  restore(ctx: CaptureContext): Promise<void>;
}
export interface ExtTexts {
  alreadyRunning: string;
  cannotQuick: string;
  challengeBeforeQuick: (challenge: string) => string;
  quickFolder: string;
}
export interface ExtKitConfig {
  /** Keep existing storage namespace and message prefix on upgrades. */
  product: string;
  brand: string;
  messagePrefix: string;
  freeDailyLimit: number;
  badgeColor: string;
  defaultSettings: Settings;
  licensing: LicensingConfig;
  downloads?: DownloadOptions;
  sameHostGapMs?: number;
  texts?: Partial<ExtTexts>;
  /** PDF/image settings validation and migration belong to the consumer. */
  normalizeSettings?(defaults: Settings, input?: unknown): Settings;
  migrateSettings?(saved: unknown): Settings;
  captureScope?(options: Settings): 'full' | 'viewport';
  scrollCapture?: ScrollCapture;
  beforeScroll?(ctx: CaptureContext): Promise<void>;
  beforeQuick?(ctx: CaptureContext, tab: BrowserTab): Promise<void>;
  afterQuick?(ctx: CaptureContext): Promise<void>;
  captureQuick?(input: { tab: BrowserTab; options: Settings; signal: AbortSignal }): Promise<CaptureOutput | null | undefined>;
  capture(ctx: CaptureContext): Promise<CaptureOutput>;
}
export interface PopupTexts {
  startNone: string;
  startSome: (n: number) => string;
  quickIng: string;
  quickFailed: string;
}
export interface PopupConfig {
  messagePrefix: string;
  queueKey: string;
  settingsKey?: string;
  quickType: string;
  quickButtonId?: string;
  texts: PopupTexts;
  onSettingsLoaded?(): void;
  collectSettings(): Settings | Promise<Settings>;
  collectQuickSettings(): Settings | Promise<Settings>;
  quickResult(result: { fileName: string; warning?: string }): string;
}
