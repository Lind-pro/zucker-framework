import type { ReadStream } from 'fs';

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  acl?: 'private' | 'public-read';
}

export interface UploadResult {
  key: string;
  /**
   * Stable public URL when the provider is configured for public delivery.
   * Private providers may return an empty string; callers must persist `key`
   * and request a short-lived URL with `getDownloadUrl` when needed.
   */
  url: string;
  size: number;
}

export interface FileInfo {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
  /**
   * 文件 MD5 哈希 — 对应 jetlinks FileInfo.md5
   * 用于文件去重和完整性校验
   */
  md5?: string;
  /**
   * 文件 SHA-256 哈希 — 对应 jetlinks FileInfo.sha256
   */
  sha256?: string;
}

export type StorageProviderType = 'local' | 's3' | 'webdav';

/**
 * 文件上传校验配置 — 对应 hsweb FileUploadProperties 的校验逻辑
 * 支持后缀名白名单/黑名单和 MIME 类型白名单/黑名单
 */
export interface FileUploadValidation {
  /** 允许的文件后缀（不含 .），设置后仅这些后缀的文件可上传 */
  allowExtensions?: string[];
  /** 拒绝的文件后缀（不含 .） */
  denyExtensions?: string[];
  /** 允许的 MIME 类型 */
  allowMimeTypes?: string[];
  /** 拒绝的 MIME 类型 */
  denyMimeTypes?: string[];
  /** 最大文件大小（字节），0 表示不限制 */
  maxFileSize?: number;
}

/**
 * Default dangerous file extensions that should be blocked unless explicitly allowed.
 * Mirrors hsweb security defaults — prevents script/executable uploads.
 */
export const DANGEROUS_EXTENSIONS: readonly string[] = [
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1',
  'sh', 'bash', 'csh', 'ksh',
  'php', 'phtml', 'php3', 'php4', 'php5', 'phps',
  'asp', 'aspx', 'jsp', 'jspx',
  'cgi', 'pl', 'py', 'rb',
  'dll', 'so', 'dylib',
  'class', 'jar', 'war',
  'htaccess', 'htpasswd',
  'svg',
];

/**
 * 文件名安全清洗 — 对齐 hsweb 5.x commit 8009845b5
 *
 * hsweb 5.x 增强了文件上传安全性：
 * 1. Unicode NFKC 规范化 — 将不同编码形式的字符统一
 *    （如全角字符 `＼` → `\`），防止绕过路径检查
 * 2. 将反斜杠统一为正斜杠后仅提取文件名部分
 * 3. 仅允许字母数字和 ._- 组成的文件名用于原始名保留
 *
 * @param fileName 原始文件名
 * @returns 清洗后的安全文件名
 */
export function sanitizeFileName(fileName: string): string {
  // Step 1: Unicode NFKC 规范化
  let normalized = fileName.normalize('NFKC');

  // Step 2: 将反斜杠替换为正斜杠，提取最后一段（即文件名部分）
  normalized = normalized.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash >= 0) {
    normalized = normalized.substring(lastSlash + 1);
  }

  // Step 3: 移除控制字符和不可见字符
  normalized = normalized.replace(/[\x00-\x1f\x7f]/g, '');

  // Step 4: 如果结果为空，说明原始文件名全是非法字符
  if (!normalized) {
    throw new Error('非法文件名');
  }

  return normalized;
}

/**
 * 检查文件名是否为安全的原始文件名（仅字母数字 ._-）
 * 对齐 hsweb 5.x: `name.matches("^[a-zA-Z0-9._-]+$")`
 */
export function isSafeOriginalFileName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/**
 * 判断文件是否被拒绝上传（基于后缀名与 MIME 类型校验）
 * 逻辑参考自 hsweb FileUploadProperties.denied()
 *
 * @param fileName 文件名
 * @param mimeType MIME 类型（可选）
 * @param validation 校验配置
 * @param fileSize 文件大小（字节，可选）— 对应 hsweb maxFileSize 校验
 */
export function isFileDenied(
  fileName: string,
  mimeType: string | undefined,
  validation: FileUploadValidation,
  fileSize?: number,
): boolean {
  // 对齐 hsweb 5.x: 先清洗文件名再校验
  const sanitized = sanitizeFileName(fileName);
  const dotIndex = sanitized.lastIndexOf('.');
  const ext = dotIndex >= 0 ? sanitized.substring(dotIndex + 1).toLowerCase() : '';

  // 文件大小校验 — 对齐 hsweb FileUploadProperties
  if (validation.maxFileSize && validation.maxFileSize > 0 && fileSize !== undefined) {
    if (fileSize > validation.maxFileSize) return true;
  }

  let defaultDeny = false;

  // 后缀黑名单
  if (validation.denyExtensions?.length) {
    if (validation.denyExtensions.includes(ext)) return true;
    defaultDeny = false;
  }

  // 后缀白名单
  if (validation.allowExtensions?.length) {
    if (validation.allowExtensions.includes(ext)) return false;
    defaultDeny = true;
  }

  // MIME 黑名单
  if (mimeType && validation.denyMimeTypes?.length) {
    if (validation.denyMimeTypes.includes(mimeType)) return true;
    defaultDeny = false;
  }

  // MIME 白名单
  if (mimeType && validation.allowMimeTypes?.length) {
    if (validation.allowMimeTypes.includes(mimeType)) return false;
    defaultDeny = true;
  }

  return defaultDeny;
}

/**
 * 生成基于日期的存储路径 — 对应 hsweb FileUploadProperties.createStaticSavePath()
 * 按 YYYYMMDD 归档，避免单目录文件过多
 */
export function generateDateBasedKey(
  originalName: string,
  options?: { useOriginalFileName?: boolean; prefix?: string },
): string {
  // 对齐 hsweb 5.x: 先清洗文件名
  const safeName = sanitizeFileName(originalName);

  const now = new Date();
  const datePart = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  const dotIndex = safeName.lastIndexOf('.');
  const ext = dotIndex >= 0 ? safeName.substring(dotIndex) : '';

  const prefix = options?.prefix ? `${options.prefix}/` : '';

  // 对齐 hsweb 5.x: 仅当文件名匹配安全字符集时才保留原始文件名
  if (options?.useOriginalFileName && isSafeOriginalFileName(safeName)) {
    const uniqueDir = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    return `${prefix}${datePart}/${uniqueDir}/${safeName}`;
  }

  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
  return `${prefix}${datePart}/${uniqueName}`;
}

/**
 * Chunk upload progress — tracks multipart/chunked upload state.
 *
 * Reference: hsweb file upload capabilities (chunked upload pattern)
 */
/**
 * POSIX 文件权限配置 — 对应 hsweb FileUploadProperties.permissions
 *
 * hsweb 通过 PosixFileAttributeView 设置文件权限，
 * 这里使用 Node.js 的 fs.chmod 模式数字实现相同功能。
 *
 * @example
 * ```ts
 * // 等同于 hsweb 设置 OWNER_READ + OWNER_WRITE + GROUP_READ
 * const permissions: PosixFilePermissions = { mode: 0o640 };
 * ```
 */
export interface PosixFilePermissions {
  /**
   * POSIX 权限模式（八进制），如 0o644, 0o755
   * 对应 hsweb PosixFilePermission 集合
   */
  mode: number;
}

export interface ChunkUploadState {
  /** Upload session ID */
  uploadId: string;
  /** Target storage key */
  key: string;
  /** Total number of chunks expected */
  totalChunks: number;
  /** Chunks received so far */
  receivedChunks: number[];
  /** Total file size in bytes (if known) */
  totalSize?: number;
  /** Whether the upload is complete */
  complete: boolean;
}

export interface FileManager {
  readonly providerType: StorageProviderType;
  isConfigured(): boolean;
  upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult>;
  uploadStream(stream: ReadStream, key: string, options?: UploadOptions): Promise<UploadResult>;
  download(key: string): Promise<{ stream: ReadStream; size: number }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getPublicUrl(key: string): Promise<string>;
  getDownloadUrl(key: string, expiresIn?: number): Promise<string>;
  list(prefix: string): Promise<FileInfo[]>;

  /**
   * 获取单个文件的元信息 — 对应 hsweb 中的文件 stat 能力
   * 返回 undefined 表示文件不存在
   */
  getFileInfo?(key: string): Promise<FileInfo | undefined>;

  /**
   * 从指定偏移量开始读取文件 — 对应 jetlinks FileManager.read(id, position)
   *
   * 支持断点续传和范围读取场景。
   * @param key 存储键
   * @param position 起始偏移量（字节）
   */
  downloadRange?(key: string, position: number, length?: number): Promise<{ stream: ReadStream; size: number }>;

  /**
   * 复制文件
   */
  copy?(sourceKey: string, destKey: string): Promise<void>;

  /**
   * 移动/重命名文件
   */
  move?(sourceKey: string, destKey: string): Promise<void>;

  /**
   * Initialize a chunked/multipart upload session.
   *
   * @param key Target storage key
   * @param totalChunks Total number of chunks expected
   * @param totalSize Total file size in bytes (optional)
   * @returns Upload session ID
   */
  initChunkedUpload?(key: string, totalChunks: number, totalSize?: number): Promise<string>;

  /**
   * Upload a single chunk in a multipart upload.
   *
   * @param uploadId Upload session ID from initChunkedUpload
   * @param chunkIndex Zero-based chunk index
   * @param buffer Chunk data
   */
  uploadChunk?(uploadId: string, chunkIndex: number, buffer: Buffer): Promise<void>;

  /**
   * Complete a chunked upload, assembling all chunks into the final file.
   *
   * @param uploadId Upload session ID
   * @param options Optional upload options (contentType, metadata, acl)
   * @returns Upload result with final URL
   */
  completeChunkedUpload?(uploadId: string, options?: UploadOptions): Promise<UploadResult>;

  /**
   * Abort a chunked upload, cleaning up any temporary chunks.
   *
   * @param uploadId Upload session ID
   */
  abortChunkedUpload?(uploadId: string): Promise<void>;

  /**
   * 便捷文件保存 — 对应 hsweb FileStorageService.saveFile(InputStream, fileType)
   *
   * 自动根据文件类型生成日期归档路径并保存，简化调用方使用。
   * 内部调用 generateDateBasedKey + upload。
   *
   * @param buffer 文件内容
   * @param fileType 文件类型/后缀（如 "png", ".jpg"）
   * @param options 上传选项
   * @returns 上传结果
   */
  saveFile?(buffer: Buffer, fileType: string, options?: UploadOptions): Promise<UploadResult>;

  /**
   * 应用 POSIX 文件权限 — 对应 hsweb FileUploadProperties.applyFilePermission()
   *
   * 在文件写入后设置 POSIX 权限（仅对本地存储有效，S3/WebDAV 忽略）。
   * hsweb 使用 PosixFileAttributeView.setPermissions()，
   * 这里使用 Node.js fs.chmodSync() 实现。
   *
   * @param key 存储键
   * @param permissions POSIX 权限配置
   */
  applyFilePermission?(key: string, permissions: PosixFilePermissions): Promise<void>;
}
