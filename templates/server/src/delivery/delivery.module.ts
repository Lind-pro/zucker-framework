import { Module } from '@nestjs/common';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider, liveObjectView } from '@zucker-framework/back-office/settings';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DELIVERY_CONNECTION, DELIVERY_CONNECTION_PROFILE, DELIVERY_OPTIONS, deliveryOptionsFromEnvironment, type DeliveryOptions } from './delivery.config';

/**
 * The `durable-email` profile is hot: `DELIVERY_CONNECTION` is a `HotProvider` that rebuilds the
 * provider client when the profile is saved, and `DELIVERY_OPTIONS` is a live read-only view of its
 * current value. A delivery in progress keeps the client it claimed with; the replaced client is
 * closed after it settles. No timer or worker lifecycle here; JobsHost is the sole
 * scheduling/closure owner.
 */
@Module({ controllers: [DeliveryController], providers: [DeliveryService,
  { provide: DELIVERY_CONNECTION, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => HotProvider.create<DeliveryOptions>(settings, environment, {
      name: 'Durable mail delivery', profiles: [DELIVERY_CONNECTION_PROFILE],
      build: env => deliveryOptionsFromEnvironment(env as NodeJS.ProcessEnv),
      dispose: options => options.provider?.close(),
    }).ready() },
  { provide: DELIVERY_OPTIONS, inject: [DELIVERY_CONNECTION], useFactory: (connection: HotProvider<DeliveryOptions>) => liveObjectView(() => connection.now(), connection) }],
  exports: [DeliveryService] })
export class DeliveryModule {}
