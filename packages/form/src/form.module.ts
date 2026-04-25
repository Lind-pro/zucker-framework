import { Global, Module, type DynamicModule } from '@nestjs/common';
import { FormService } from './form.service';

/**
 * ZuckerFormModule — pluggable NestJS module for form engine.
 *
 * Usage:
 * ```typescript
 * ZuckerFormModule.forRoot()
 * ```
 *
 * Prerequisites:
 * - ZuckerCrudModule.forRoot(...) — provides DATABASE_ADAPTER globally
 */
@Global()
@Module({})
export class ZuckerFormModule {
  static forRoot(): DynamicModule {
    return {
      module: ZuckerFormModule,
      providers: [FormService],
      exports: [FormService],
    };
  }
}
