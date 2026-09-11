import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditModuleWiring,
  auditFrameworkSourceText,
  auditPnpmWorkflowVersions,
  findTransactionBoundaryViolations,
  type ModuleWiringAuditOptions,
} from '../index';

function audit(
  files: Record<string, string>,
  globalGuards: ModuleWiringAuditOptions['globalGuards'] = {
    owner: 'composition.ts',
    classes: ['SessionGuard'],
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'framework-module-audit-'));
  try {
    for (const [file, source] of Object.entries(files)) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    }
    return auditModuleWiring({
      sourceRoot: root,
      schedulerRoot: 'composition.ts',
      globalGuards,
      infrastructureProviders: { ConnectionPool: 'pool.ts' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const baseline = {
  'composition.ts': `import { Module } from '@nestjs/common'; import * as Schedule from '@nestjs/schedule'; import { APP_GUARD } from '@nestjs/core';
    @Module({ imports: [Schedule.ScheduleModule.forRoot()], providers: [{ provide: APP_GUARD, useClass: SessionGuard }] }) export class Application {}`,
  'pool.ts': `import { Module } from '@nestjs/common'; @Module({ providers: [ConnectionPool] }) export class PoolModule {}`,
};

describe('source audit tooling', () => {
  it('accepts an explicitly configured named guard factory and resolves import aliases', () => {
    const files = {
      ...baseline,
      'composition.ts':
        baseline['composition.ts'].replace(
          'providers: [',
          'providers: [{ provide: APP_GUARD, useFactory: (makePermissionGuard) },',
        ) + `\nimport { createPermissionGuard as makePermissionGuard } from './guards';`,
    };
    expect(
      audit(files, {
        owner: 'composition.ts',
        classes: ['SessionGuard'],
        factories: ['createPermissionGuard'],
      }).ok,
    ).toBe(true);
  });

  it('continues rejecting missing, duplicate, wrong-owner and anonymous guard factories', () => {
    const globals = {
      owner: 'composition.ts',
      classes: ['SessionGuard'],
      factories: ['createPermissionGuard'],
    };
    const module = baseline['composition.ts'].replace(
      'providers: [',
      'providers: [{ provide: APP_GUARD, useFactory: createPermissionGuard },',
    );
    const cases = [
      baseline,
      {
        ...baseline,
        'composition.ts': module.replace(
          'providers: [',
          'providers: [{ provide: APP_GUARD, useFactory: createPermissionGuard },',
        ),
      },
      {
        ...baseline,
        'other.ts': `import { Module } from '@nestjs/common'; import { APP_GUARD } from '@nestjs/core'; @Module({providers:[{provide:APP_GUARD,useFactory:createPermissionGuard}]}) export class Other {}`,
      },
      {
        ...baseline,
        'composition.ts': module.replace(
          'useFactory: createPermissionGuard',
          'useFactory: () => new PermissionGuard()',
        ),
      },
      {
        ...baseline,
        'composition.ts': module.replace(
          'useFactory: createPermissionGuard',
          'useClass: createPermissionGuard',
        ),
      },
    ];
    for (const files of cases) {
      expect(
        audit(files, globals).findings.some(({ code }) => code === 'global-guard-composition'),
      ).toBe(true);
    }
  });
  it('uses consumer-selected module owners and guards', () => {
    expect(audit(baseline).ok).toBe(true);
    const report = audit({
      ...baseline,
      'feature.ts': `import { Module } from '@nestjs/common';
      @Module({ providers: [ConnectionPool] }) export class Feature {}`,
    });
    expect(report.findings.some(({ code }) => code === 'infrastructure-provider-owner')).toBe(true);
  });

  it('detects lifecycle aliases and cron overlap through imported decorators', () => {
    const report = audit({
      ...baseline,
      'events.ts': `import { Module, OnModuleDestroy } from '@nestjs/common';
      import { Cron as Scheduled } from '@nestjs/schedule';
      class Events implements OnModuleDestroy { onModuleDestroy() {} @Scheduled('* * * * *') tick() {} }
      @Module({ providers: [Events, { provide: 'ALIAS', useFactory: (events: Events) => events, inject: [Events] }] }) export class EventsModule {}`,
    });
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['cron-overlap-guard', 'lifecycle-provider-factory-alias']),
    );
  });

  it('applies transaction service patterns without any product vocabulary', () => {
    const policy = {
      rootClientNames: ['db'],
      transactionClientRequiredPattern: /^service\./,
      externalCallPattern: /^dispatch$/,
    };
    const violations = findTransactionBoundaryViolations(
      'db.$transaction(async tx => { await db.items.findMany(); service.save(item); dispatch(event); });',
      'sample.ts',
      policy,
    );
    expect(violations).toHaveLength(3);
    expect(
      findTransactionBoundaryViolations(
        'db.$transaction(async tx => { await tx.items.findMany(); service.save(item, tx); });',
        'sample.ts',
        policy,
      ),
    ).toEqual([]);
  });

  it('retains public import and toolchain checks with consumer runtime import rules', () => {
    expect(
      auditFrameworkSourceText(
        'instructions.mjs',
        `import { auditAgentInstructions } from '@zucker-framework/cli/agent-instructions';
         import { LangChainCallObserver } from '@zucker-framework/ai/langchain';`,
      ),
    ).toEqual([]);
    expect(
      auditFrameworkSourceText(
        'runtime.ts',
        `import { hidden } from '@zucker-framework/core/private';`,
      ),
    ).toHaveLength(1);
    expect(
      auditFrameworkSourceText('runtime.ts', `import { connection } from 'vendor';`, [
        { specifier: 'vendor', matchesFile: () => true, message: 'use configured transport' },
      ]),
    ).toEqual(['runtime.ts: use configured transport']);
    expect(
      auditPnpmWorkflowVersions('pnpm@11.25.0', [
        ['workflow.yml', 'uses: pnpm/action-setup@v6\nwith:\n  version: 11.25.0'],
      ]),
    ).toEqual([]);
    expect(
      auditPnpmWorkflowVersions('pnpm@11.25.0', [
        ['workflow.yml', 'uses: pnpm/action-setup@v6\nwith:\n  version: 10.0.0'],
      ]),
    ).toHaveLength(1);
  });
});
