import * as fs from 'fs';
import * as path from 'path';
import { ResourceProvider } from './resource-manager';

/**
 * 从项目目录的 JSON 文件加载资源
 */
export class ClasspathResourceProvider implements ResourceProvider {
  constructor(
    private readonly type: string,
    private readonly basePath: string,
  ) {}

  getType(): string {
    return this.type;
  }

  async getResource(id: string): Promise<any> {
    const filePath = path.join(this.basePath, `${id}.json`);
    const resolved = path.resolve(filePath);
    const baseResolved = path.resolve(this.basePath);
    if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
      throw new Error(`Path traversal detected: "${id}"`);
    }
    if (!fs.existsSync(filePath)) return undefined;

    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }

  async listResources(): Promise<string[]> {
    if (!fs.existsSync(this.basePath)) return [];

    return fs
      .readdirSync(this.basePath)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json'));
  }
}
