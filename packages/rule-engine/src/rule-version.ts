import { Injectable, Logger } from '@nestjs/common';
import type { RuleDefinition } from './rule-engine.service';

/**
 * 规则版本管理。
 */
export interface RuleVersion {
  ruleId: string;
  version: number;
  definition: RuleDefinition;
  createdAt: number;
  createdBy?: string;
  changeLog?: string;
  /** 是否为当前活跃版本 */
  active: boolean;
}

@Injectable()
export class RuleVersionManager {
  private readonly logger = new Logger(RuleVersionManager.name);
  private readonly versions = new Map<string, RuleVersion[]>();

  /** 保存规则新版本 */
  saveVersion(
    ruleId: string,
    definition: RuleDefinition,
    options?: { createdBy?: string; changeLog?: string },
  ): RuleVersion {
    const history = this.versions.get(ruleId) ?? [];

    // 将旧版本标为非活跃
    for (const v of history) {
      v.active = false;
    }

    const version: RuleVersion = {
      ruleId,
      version: history.length + 1,
      definition: JSON.parse(JSON.stringify(definition)),
      createdAt: Date.now(),
      createdBy: options?.createdBy,
      changeLog: options?.changeLog,
      active: true,
    };

    history.push(version);
    this.versions.set(ruleId, history);
    this.logger.log(`Rule version saved: ${ruleId} v${version.version}`);
    return version;
  }

  /** 获取规则的所有历史版本 */
  getVersions(ruleId: string): RuleVersion[] {
    return [...(this.versions.get(ruleId) ?? [])];
  }

  /** 获取规则的当前活跃版本 */
  getActiveVersion(ruleId: string): RuleVersion | undefined {
    return this.versions.get(ruleId)?.find(v => v.active);
  }

  /** 获取指定版本 */
  getVersion(ruleId: string, version: number): RuleVersion | undefined {
    return this.versions.get(ruleId)?.find(v => v.version === version);
  }

  /** 回滚到指定版本 */
  rollback(ruleId: string, targetVersion: number): RuleVersion | undefined {
    const history = this.versions.get(ruleId);
    if (!history) return undefined;

    const target = history.find(v => v.version === targetVersion);
    if (!target) return undefined;

    for (const v of history) {
      v.active = v.version === targetVersion;
    }

    this.logger.log(`Rule rolled back: ${ruleId} → v${targetVersion}`);
    return target;
  }

  /** 比较两个版本的差异 */
  diff(ruleId: string, v1: number, v2: number): { added: string[]; removed: string[]; modified: string[] } | undefined {
    const ver1 = this.getVersion(ruleId, v1);
    const ver2 = this.getVersion(ruleId, v2);
    if (!ver1 || !ver2) return undefined;

    const keys1 = new Set(Object.keys(ver1.definition));
    const keys2 = new Set(Object.keys(ver2.definition));

    const added = [...keys2].filter(k => !keys1.has(k));
    const removed = [...keys1].filter(k => !keys2.has(k));
    const modified = [...keys1].filter(k =>
      keys2.has(k) && JSON.stringify((ver1.definition as unknown as Record<string, unknown>)[k]) !== JSON.stringify((ver2.definition as unknown as Record<string, unknown>)[k])
    );

    return { added, removed, modified };
  }
}

/**
 * 规则测试框架 — 验证规则定义的正确性。
 */
export interface RuleTestCase {
  name: string;
  /** 输入数据 */
  input: Record<string, unknown>;
  /** 期望的输出/结果 */
  expected: {
    /** 期望触发的 action 名称列表 */
    triggeredActions?: string[];
    /** 期望的条件评估结果 */
    conditionResult?: boolean;
    /** 期望的输出数据 */
    output?: Record<string, unknown>;
  };
}

export interface RuleTestResult {
  testCase: string;
  passed: boolean;
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
  error?: string;
  duration: number;
}

@Injectable()
export class RuleTestRunner {
  private readonly logger = new Logger(RuleTestRunner.name);

  /** 运行单个测试用例 */
  async runTest(
    definition: RuleDefinition,
    testCase: RuleTestCase,
    executor: { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> },
  ): Promise<RuleTestResult> {
    const start = Date.now();
    try {
      const actual = await executor.execute(testCase.input);
      const passed = this.compareResults(actual, testCase.expected);

      return {
        testCase: testCase.name,
        passed,
        actual,
        expected: testCase.expected as Record<string, unknown>,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        testCase: testCase.name,
        passed: false,
        actual: {},
        expected: testCase.expected as Record<string, unknown>,
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  }

  /** 运行多个测试用例 */
  async runTests(
    definition: RuleDefinition,
    testCases: RuleTestCase[],
    executor: { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> },
  ): Promise<{ results: RuleTestResult[]; passed: number; failed: number; total: number }> {
    const results: RuleTestResult[] = [];
    for (const tc of testCases) {
      results.push(await this.runTest(definition, tc, executor));
    }
    const passed = results.filter(r => r.passed).length;
    return { results, passed, failed: results.length - passed, total: results.length };
  }

  private compareResults(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(value)) return false;
    }
    return true;
  }
}
