import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DEFAULT_QUOTA_RESERVATION_PROJECTION, DEFAULT_QUOTA_USAGE_PROJECTION, createPlanAdminController, createQuotaAdminControllers,
  createUserSubscriptionAdminController,
} from '@zucker-framework/admin';
import { createSubscriptionsController } from './subscriptions.controller';
import {
  resolveSubscriptionsOptions, resolveSubscriptionsSettings, type BackOfficeSubscriptionsOptions, type ResolvedSubscriptionsOptions,
  type SubscriptionsSettings, type SubscriptionsSettingsFactory, type SubscriptionsSettingsResolver,
} from './subscriptions.options';
import { SubscriptionsService } from './subscriptions.service';
import {
  SUBSCRIPTIONS_BILLING, SUBSCRIPTIONS_EVENT_BUS, SUBSCRIPTIONS_OPTIONS, SUBSCRIPTIONS_PLAN_CATALOG, SUBSCRIPTIONS_QUOTA_RESERVATIONS,
  SUBSCRIPTIONS_SETTINGS, SUBSCRIPTIONS_VIEWER,
} from './subscriptions.tokens';

/** Admin projection with the host's field map applied (response key → adapter field). */
function project(projection: Readonly<Record<string, string>>, fields: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(projection).map(([key, field]) => [key, fields[field] ?? field]));
}

/** Settings validated once per distinct value a resolver returns. */
function settingsResolver(source: SubscriptionsSettingsResolver | Partial<SubscriptionsSettings>): SubscriptionsSettingsResolver {
  if (typeof source !== 'function') {
    const fixed = resolveSubscriptionsSettings(source);
    return () => fixed;
  }
  const seen = new WeakMap<object, SubscriptionsSettings>();
  return () => {
    const raw = source();
    let resolved = raw && typeof raw === 'object' ? seen.get(raw) : undefined;
    if (!resolved) {
      resolved = resolveSubscriptionsSettings(raw);
      if (raw && typeof raw === 'object') seen.set(raw, resolved);
    }
    return resolved;
  };
}

function settingsProvider(settings: ResolvedSubscriptionsOptions['settings']): Provider {
  const factory = settings as SubscriptionsSettingsFactory;
  if (typeof factory.useFactory === 'function')
    return { provide: SUBSCRIPTIONS_SETTINGS, inject: factory.inject ?? [],
      useFactory: (...args: never[]) => {
        const resolver = settingsResolver(factory.useFactory(...args));
        resolver(); // fail at startup on an invalid initial value
        return resolver;
      } };
  return { provide: SUBSCRIPTIONS_SETTINGS, useValue: settingsResolver(settings as Partial<SubscriptionsSettings>) };
}

/** `EventEmitter2` when `@nestjs/event-emitter` is installed and its module registered; else undefined. */
const eventBusProvider: Provider = {
  provide: SUBSCRIPTIONS_EVENT_BUS,
  inject: [ModuleRef],
  useFactory: async (moduleRef: ModuleRef) => {
    try {
      const { EventEmitter2 } = await import('@nestjs/event-emitter');
      return moduleRef.get(EventEmitter2, { strict: false });
    } catch {
      return undefined;
    }
  },
};

/**
 * Plans, user subscriptions, entitlements and metered quota (server half of the back office).
 *
 * The consumer root provides `DATABASE_ADAPTER` (transactions must expose `query(sql, values)` when
 * the default locks or the SQL billing link are used), the auth module and, optionally, the event
 * emitter. Every route group is a feature; a disabled one registers no controller.
 */
@Module({})
export class BackOfficeSubscriptionsModule {
  static forRoot(input: BackOfficeSubscriptionsOptions): DynamicModule {
    const options = resolveSubscriptionsOptions(input);
    const { features, paths, guards, permissions, storage } = options;
    const controllers: Type<unknown>[] = [];
    if (features.publicRoutes) controllers.push(createSubscriptionsController({ path: paths.public, ...(guards ? { guards } : {}) }));
    if (features.planAdmin)
      controllers.push(createPlanAdminController({ path: paths.plans, service: SUBSCRIPTIONS_PLAN_CATALOG,
        ...(permissions.plans ? { permissions: permissions.plans } : {}), ...(guards ? { guards } : {}) }));
    if (features.subscriptionAdmin)
      controllers.push(createUserSubscriptionAdminController({ path: paths.subscriptions, service: SubscriptionsService,
        ...(permissions.subscriptions ? { permissions: permissions.subscriptions } : {}), ...(guards ? { guards } : {}) }));
    if (features.quotaAdmin) {
      const quota = createQuotaAdminControllers({
        usagePath: paths.quotaUsage, reservationsPath: paths.quotaReservations,
        usageModel: storage.models.quotaUsage, reservationModel: storage.models.quotaReservations,
        usageProjection: project(DEFAULT_QUOTA_USAGE_PROJECTION, storage.fields.quotaUsage),
        reservationProjection: project(DEFAULT_QUOTA_RESERVATION_PROJECTION, storage.fields.quotaReservations),
        reservations: SUBSCRIPTIONS_QUOTA_RESERVATIONS,
        ...(permissions.quota ? { permissions: permissions.quota } : {}), ...(guards ? { guards } : {}),
      });
      controllers.push(quota.usage, quota.reservations);
    }
    const providers: Provider[] = [
      { provide: SUBSCRIPTIONS_OPTIONS, useValue: options },
      settingsProvider(options.settings),
      eventBusProvider,
      ...(options.billing !== undefined ? [{ provide: SUBSCRIPTIONS_BILLING, useExisting: options.billing }] : []),
      ...(options.viewer ? [{ provide: SUBSCRIPTIONS_VIEWER, useClass: options.viewer }] : []),
      SubscriptionsService,
      { provide: SUBSCRIPTIONS_PLAN_CATALOG, inject: [SubscriptionsService], useFactory: (service: SubscriptionsService) => service.plans },
      { provide: SUBSCRIPTIONS_QUOTA_RESERVATIONS, inject: [SubscriptionsService], useFactory: (service: SubscriptionsService) => service.reservations },
    ];
    return {
      module: BackOfficeSubscriptionsModule,
      imports: options.imports,
      controllers,
      providers,
      exports: [SubscriptionsService, SUBSCRIPTIONS_OPTIONS, SUBSCRIPTIONS_SETTINGS, SUBSCRIPTIONS_PLAN_CATALOG, SUBSCRIPTIONS_QUOTA_RESERVATIONS],
    };
  }
}
