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
    const base = path.resolve(this.basePath);
    const resolved = path.resolve(base, this.extension ? `${id}.${this.extension}` : id);

    // 防止路径遍历：结果必须严格位于 basePath 之内。仅做 startsWith 前缀比较会放过
    // 同级目录（/data/res 与 /data/res-secret），因此用 path.relative 判断。
    const relative = path.relative(base, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
