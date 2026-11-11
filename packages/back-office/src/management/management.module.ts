import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';
import { createManagementController } from './management.controller';
import { resolveManagementOptions, type BackOfficeManagementOptions } from './management.options';
import { BackOfficeManagementService } from './management.service';
import {
  MANAGEMENT_CONNECTIONS,
  MANAGEMENT_CREDIT_LEDGER,
  MANAGEMENT_CREDITS,
  MANAGEMENT_OPTIONS,
  MANAGEMENT_REFUND_SUMMARY,
} from './management.tokens';

export interface BackOfficeManagementModuleOptions extends BackOfficeManagementOptions {
  /** Modules the port classes need (they are registered with `useClass` inside this module). */
  imports?: ModuleMetadata['imports'];
}

/**
 * `/management/*` read models, administrator credit grant and connection inventory. Needs the
 * consumer's `DATABASE_ADAPTER` (`@zucker-framework/crud`); log lists need
 * `ZuckerLoggingModule.forRoot({ persistence })`; guards and the rate limiter are the consumer's.
 */
@Module({})
export class BackOfficeManagementModule {
  static forRoot(input: BackOfficeManagementModuleOptions = {}): DynamicModule {
    const { imports, ...rest } = input;
    const options = resolveManagementOptions(rest);
    const port = (token: symbol, type: unknown): Provider[] => (type ? [{ provide: token, useClass: type as never }] : []);
    const providers: Provider[] = [
      { provide: MANAGEMENT_OPTIONS, useValue: options },
      BackOfficeManagementService,
      ...port(MANAGEMENT_REFUND_SUMMARY, options.ports.refunds),
      ...port(MANAGEMENT_CREDITS, options.features.creditAccounts && options.ports.credits),
      ...port(MANAGEMENT_CREDIT_LEDGER, options.features.creditAccounts && options.ports.creditLedger),
      ...port(MANAGEMENT_CONNECTIONS, options.features.connections && options.ports.connections),
    ];
    return {
      module: BackOfficeManagementModule,
      imports: imports ?? [],
      controllers: [createManagementController(options, { service: BackOfficeManagementService })],
      providers,
      exports: [BackOfficeManagementService, MANAGEMENT_OPTIONS],
    };
  }
}
