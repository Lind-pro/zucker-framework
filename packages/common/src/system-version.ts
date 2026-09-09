/**
 * 系统版本信息
 *
 * SystemVersion 跟踪：
 *   - 框架自身版本 (FrameworkVersion)
 *   - 应用版本 (majorVersion.minorVersion.revisionVersion[-SNAPSHOT])
 *   - 依赖列表 (Dependency[])
 *
 * 提供 setVersion(string) 解析能力和 getDependency() 查询能力。
 */

export interface Dependency {
  groupId: string;
  artifactId: string;
  version: string;
  description?: string;
}

export class Version {
  name = '';
  comment = '';
  website = '';
  majorVersion = 0;
  minorVersion = 0;
  revisionVersion = 0;
  snapshot = false;

  setVersion(major: number, minor: number, revision: number, snapshot?: boolean): void;
  setVersion(versionString: string): void;
  setVersion(
    majorOrString: number | string,
    minor?: number,
    revision?: number,
    snapshot?: boolean,
  ): void {
    if (typeof majorOrString === 'string') {
      this.parseVersion(majorOrString);
    } else {
      this.majorVersion = majorOrString;
      this.minorVersion = minor ?? 0;
      this.revisionVersion = revision ?? 0;
      this.snapshot = snapshot ?? false;
    }
  }

  private parseVersion(version: string): void {
    const isSnapshot = version.toUpperCase().includes('-SNAPSHOT');
    const cleaned = version.replace(/-SNAPSHOT/i, '');
    const parts = cleaned.split('.').map(Number);
    this.majorVersion = parts[0] || 0;
    this.minorVersion = parts[1] || 0;
    this.revisionVersion = parts[2] || 0;
    this.snapshot = isSnapshot;
  }

  toString(): string {
    const base = `${this.majorVersion}.${this.minorVersion}.${this.revisionVersion}`;
    return this.snapshot ? `${base}-SNAPSHOT` : base;
  }
}

export class FrameworkVersion extends Version {
  constructor() {
    super();
    this.name = 'zucker framework';
    this.comment = 'Enterprise backend framework for TypeScript';
    this.website = 'https://github.com/nicerapp/zucker';
    this.setVersion(1, 0, 0, true);
  }
}

export class SystemVersion extends Version {
  frameworkVersion = new FrameworkVersion();
  private dependencies: Dependency[] = [];
  private depCache = new Map<string, Dependency>();

  constructor(version?: string) {
    super();
    if (version) {
      this.setVersion(version);
    }
  }

  setDependencies(deps: Dependency[]): void {
    this.dependencies = deps;
    this.initDepCache();
  }

  getDependencies(): Dependency[] {
    return this.dependencies;
  }

  getDependency(groupId: string, artifactId: string): Dependency | undefined {
    return this.depCache.get(`${groupId}/${artifactId}`);
  }

  addDependency(dep: Dependency): void {
    this.dependencies.push(dep);
    this.depCache.set(`${dep.groupId}/${dep.artifactId}`, dep);
  }

  private initDepCache(): void {
    this.depCache.clear();
    for (const dep of this.dependencies) {
      this.depCache.set(`${dep.groupId}/${dep.artifactId}`, dep);
    }
  }
}
