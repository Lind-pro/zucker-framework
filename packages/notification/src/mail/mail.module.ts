import {
  Global,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { MailService, type MailServiceOptions } from './mail.service';
import { MailHistoryService } from './mail-history.service';
import { MailTemplateCatalog } from './template-catalog';

export interface MailModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: unknown[]) => MailServiceOptions | Promise<MailServiceOptions>;
}

@Global()
@Module({})
export class ZuckerMailModule {
  static forRoot(options: MailServiceOptions): DynamicModule {
    return this.forRootAsync({ useFactory: () => options });
  }
  static forRootAsync(options: MailModuleAsyncOptions): DynamicModule {
    return {
      module: ZuckerMailModule,
      global: true,
      imports: options.imports,
      providers: [
        {
          provide: MailService,
          useFactory: async (...args: unknown[]) =>
            new MailService(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        {
          provide: MailHistoryService,
          useFactory: (mail: MailService) => mail.history,
          inject: [MailService],
        },
        {
          provide: MailTemplateCatalog,
          useFactory: (mail: MailService) => mail.templates,
          inject: [MailService],
        },
      ],
      exports: [MailService, MailTemplateCatalog, MailHistoryService],
    };
  }
}
