import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';

/**
 * ZuckerConfigAdminModule
 *
 * ConfigService is provided globally by ZuckerConfigModule.forRoot().
 */
@Module({
  controllers: [ConfigController],
})
export class ZuckerConfigAdminModule {}
