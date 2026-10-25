import { Module } from '@nestjs/common';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DELIVERY_OPTIONS, deliveryOptionsFromEnvironment } from './delivery.config';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

/** No timer or worker lifecycle here; JobsHost is the sole scheduling/closure owner. */
@Module({ controllers: [DeliveryController], providers: [DeliveryService,
  { provide: DELIVERY_OPTIONS, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => deliveryOptionsFromEnvironment(environment ?? process.env) }], exports: [DeliveryService] })
export class DeliveryModule {}
