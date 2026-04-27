import {
  Module,
  type DynamicModule,
  type Type,
  type Provider,
  type InjectionToken,
} from '@nestjs/common';
import { type DatabaseAdapter } from '@zucker/core';
import { DATABASE_ADAPTER } from './crud.module';
import { PrismaAdapter } from './prisma-adapter';

export interface PrismaDatabaseAdapterModuleOptions {
  /** 项目侧 PrismaService class（构造时会被作为 inject token） */
  prismaService: Type<unknown>;

  /** 项目侧 PrismaModule（含 PrismaService）。
   *  通常需要传入，否则在 forRoot 模块作用域内拿不到 PrismaService。 */
  prismaModule?: Type<unknown> | DynamicModule;

  /**
   * 业务侧扩展模型名别名。会与框架默认别名 merge。
   * 例：{ aiModels: 'aIModel' }（Prisma client AIModel → aIModel）
   */
  modelAliases?: Record<string, string>;

  /** 是否注册为 @Global()。默认 true（@zucker/ai 等需全局可见 DATABASE_ADAPTER） */
  global?: boolean;
}

/**
 * 现成的 Nest dynamic module：把 PrismaService 包装成 `DATABASE_ADAPTER`
 * provider，让 @zucker/ai 的 AIConfigService、PromptManager 等开箱使用。
 *
 * 比 ZuckerCrudModule.forRootAsync 更轻量：不带 dynamic-query / 操作符 /
 * BaseService 等 CRUD 周边，仅注册 DATABASE_ADAPTER + PrismaAdapter 实例。
 *
 * 用法（项目 AppModule）：
 * ```ts
 * import { PrismaModule, PrismaService } from '@/prisma';
 *
 * @Module({
 *   imports: [
 *     PrismaDatabaseAdapterModule.forRoot({
 *       prismaService: PrismaService,
 *       prismaModule: PrismaModule,
 *       modelAliases: { aiModels: 'aIModel' },
 *     }),
 *     ZuckerAIModule.forRoot({ ... }),
 *   ],
 * })
 * ```
 */
@Module({})
export class PrismaDatabaseAdapterModule {
  static forRoot(options: PrismaDatabaseAdapterModuleOptions): DynamicModule {
    const adapterProvider: Provider = {
      provide: PrismaAdapter,
      useFactory: (prisma: object) =>
        new PrismaAdapter(prisma as never, { modelAliases: options.modelAliases }),
      inject: [options.prismaService as InjectionToken],
    };

    const tokenProvider: Provider = {
      provide: DATABASE_ADAPTER,
      useExisting: PrismaAdapter,
    };

    const imports: DynamicModule['imports'] = [];
    if (options.prismaModule) imports.push(options.prismaModule as Type<unknown>);

    const isGlobal = options.global ?? true;
    return {
      module: PrismaDatabaseAdapterModule,
      global: isGlobal,
      imports,
      providers: [adapterProvider, tokenProvider],
      exports: [DATABASE_ADAPTER, PrismaAdapter],
    };
  }
}

/** 帮助类型推断 — re-export 方便业务侧从同一个包 import */
export type { DatabaseAdapter };
