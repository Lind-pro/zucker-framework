import * as fs from 'fs';
import * as path from 'path';
import { ResourceProvider } from './resource-manager';

/**
 * 从文件系统加载资源（支持任意文件类型）
 */
export class FileResourceProvider implements ResourceProvider {
  constructor(
    private readonly type: string,
    private readonly basePath: string,
    private readonly extension = '',
  ) {}

  getType(): string {
    return this.type;
  }

  async getResource(id: string): Promise<Buffer | undefined> {
    const filePath = path.join(this.basePath, this.extension ? `${id}.${this.extension}` : id);

    // 防止路径遍历
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.basePath))) {
      throw new Error('Path traversal detected');
    }

    if (!fs.existsSync(resolved)) return undefined;
    return fs.readFileSync(resolved);
  }

  async listResources(): Promise<string[]> {
    if (!fs.existsSync(this.basePath)) return [];

    return fs.readdirSync(this.basePath).map((f) => {
      if (this.extension) {
        return path.basename(f, `.${this.extension}`);
      }
      return f;
    });
  }
}
