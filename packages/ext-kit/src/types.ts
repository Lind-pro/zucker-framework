export type Settings = Record<string, unknown>;

export interface CaptureContext {
  /** batch = 后台批量新开 tab；quick = 用户当前浏览的 tab（不得改视口、需还原页面状态） */
  mode: 'batch' | 'quick';
  tabId: number;
  url: string;
  options: Settings;
  /** chrome.debugger sendCommand（已 attach） */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CaptureOutput {
  base64: string;
  mime: string;
  /** 文件扩展名，不含点："png" | "jpg" | "pdf" … */
  extension: string;
  /** 非致命告警（如超高截断），展示在结果列表 */
  warning?: string;
}

export interface LicensingConfig {
  apiBase: string;
  purchaseUrl: string;
}

/** 措辞（capture/convert 等动词差异）；不配则用 capture 系默认值 */
export interface ExtTexts {
  alreadyRunning: string;
  cannotQuick: string;
  challengeBeforeQuick: (challenge: string) => string;
  quickFolder: string;
}

export interface ExtKitConfig {
  /** 消费项目提供的存储 key 命名空间；已发布产品应保持原值，以兼容既有安装 */
  product: string;
  /** 品牌名：下载文件夹前缀、设备名 */
  brand: string;
  /** 消费项目提供的消息类型前缀，用于构造 START 等消息类型 */
  messagePrefix: string;
  freeDailyLimit?: number;
  badgeColor: string;
  defaultSettings: Settings;
  licensing: LicensingConfig;
  texts?: Partial<ExtTexts>;
  /** 仅批量模式、autoScroll 之前调用（如固定视口宽度）；quick 模式不调用（不能动用户的 tab） */
  beforeScroll?(ctx: CaptureContext): Promise<void>;
  /** 核心业务：页面已加载、已过验证、已滚动揭示，产出要下载的数据 */
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
  /** 消费项目提供的 URL 队列存储 key；已发布产品应保持原值 */
  queueKey: string;
  /** 快速处理当前页的消息类型后缀：CAPTURE_CURRENT / CONVERT_CURRENT */
  quickType: string;
  /** 快速按钮的元素 id，默认 "captureCurrent"，可由消费项目覆盖 */
  quickButtonId?: string;
  texts: PopupTexts;
  collectSettings(): Settings;
  collectQuickSettings(): Settings;
  /** 快速处理成功后的状态栏文案 */
  quickResult(result: { fileName: string; warning?: string }): string;
}
