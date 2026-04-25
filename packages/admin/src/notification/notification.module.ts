import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';

/**
 * ZuckerNotificationAdminModule
 *
 * TemplateService and NotifyHistoryService are provided globally by
 * ZuckerNotificationModule.forRoot().
 */
@Module({
  controllers: [NotificationController],
})
export class ZuckerNotificationAdminModule {}
