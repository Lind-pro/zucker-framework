import { Module } from '@nestjs/common';
import { LoggingController } from './logging.controller';

/**
 * ZuckerLoggingAdminModule
 *
 * LoggingController uses @OnEvent(ACCESS_LOG_EVENT) to receive log events
 * from @zucker-framework/logging's AccessLoggerInterceptor. EventEmitter is assumed
 * to be globally configured by EventEmitterModule.forRoot().
 */
@Module({
  controllers: [LoggingController],
})
export class ZuckerLoggingAdminModule {}
