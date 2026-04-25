import { Logger } from '@nestjs/common';
import { watch, type FSWatcher, existsSync, statSync } from 'fs';

/**
 * 配置文件热重载监听器 — 对标 Claude Code changeDetector.ts
 *
 * 监听配置文件变化，带写入稳定性检测和删除宽限期。
 *
 * 用法:
 * ```ts
 * const watcher = new ConfigFileWatcher();
 * watcher.watch('/path/to/config.json', () => {
 *   configService.clearCache();
 *   logger.log('Config reloaded');
 * });
 *
 * // 停止监听
 * watcher.close();
 * ```
 */

export interface ConfigWatcherOptions {
  /** 写入稳定性延迟：文件修改后等待此时间无新修改才触发回调（毫秒） */
  stabilityMs?: number;
  /** 删除宽限期：文件删除后等待此时间，若重建则不触发删除回调 */
  deleteGraceMs?: number;
}

interface WatchedFile {
  path: string;
  callback: () => void;
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  deleteGraceTimer: ReturnType<typeof setTimeout> | null;
  lastModified: number;
}

export class ConfigFileWatcher {
  private readonly logger = new Logger(ConfigFileWatcher.name);
  private readonly stabilityMs: number;
  private readonly deleteGraceMs: number;
  private readonly watched = new Map<string, WatchedFile>();

  constructor(options: ConfigWatcherOptions = {}) {
    this.stabilityMs = options.stabilityMs ?? 1000;
    this.deleteGraceMs = options.deleteGraceMs ?? 1700;
  }

  /**
   * 开始监听文件
   * @returns 取消监听函数
   */
  watch(filePath: string, callback: () => void): () => void {
    if (this.watched.has(filePath)) {
      this.unwatch(filePath);
    }

    const entry: WatchedFile = {
      path: filePath,
      callback,
      watcher: null,
      debounceTimer: null,
      deleteGraceTimer: null,
      lastModified: this.getModifiedTime(filePath),
    };

    try {
      entry.watcher = watch(filePath, (eventType) => {
        this.handleEvent(entry, eventType);
      });

      entry.watcher.on('error', (err) => {
        this.logger.warn(`Watch error on ${filePath}: ${err.message}`);
      });
    } catch {
      // 文件不存在时 watch 会抛出，改用目录监听或轮询
      this.logger.warn(`Cannot watch ${filePath} — file may not exist yet`);
    }

    this.watched.set(filePath, entry);

    return () => this.unwatch(filePath);
  }

  /**
   * 停止监听指定文件
   */
  unwatch(filePath: string): void {
    const entry = this.watched.get(filePath);
    if (!entry) return;

    entry.watcher?.close();
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.deleteGraceTimer) clearTimeout(entry.deleteGraceTimer);
    this.watched.delete(filePath);
  }

  /**
   * 关闭所有监听
   */
  close(): void {
    for (const path of [...this.watched.keys()]) {
      this.unwatch(path);
    }
  }

  /**
   * 获取当前监听的文件列表
   */
  getWatchedFiles(): string[] {
    return [...this.watched.keys()];
  }

  private handleEvent(entry: WatchedFile, eventType: string): void {
    if (eventType === 'rename') {
      // 文件可能被删除或原子替换（delete + create）
      if (!existsSync(entry.path)) {
        // 可能是原子替换的中间状态——等宽限期
        if (entry.deleteGraceTimer) clearTimeout(entry.deleteGraceTimer);
        entry.deleteGraceTimer = setTimeout(() => {
          entry.deleteGraceTimer = null;
          if (!existsSync(entry.path)) {
            // 文件确实被删除了
            this.logger.warn(`Config file deleted: ${entry.path}`);
          }
        }, this.deleteGraceMs);
        return;
      }

      // 文件重建（宽限期内重建 = 原子替换）
      if (entry.deleteGraceTimer) {
        clearTimeout(entry.deleteGraceTimer);
        entry.deleteGraceTimer = null;
      }
    }

    // 写入稳定性：debounce，等文件写完
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;

      // 检查文件是否真的变了
      const newModified = this.getModifiedTime(entry.path);
      if (newModified === entry.lastModified) return;
      entry.lastModified = newModified;

      this.logger.log(`Config changed: ${entry.path}`);
      try {
        entry.callback();
      } catch (err) {
        this.logger.error(`Config reload callback failed: ${err}`);
      }
    }, this.stabilityMs);
  }

  private getModifiedTime(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }
}
