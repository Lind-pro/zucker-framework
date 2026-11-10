import { Module } from '@nestjs/common';
import { CONTENT_OPTIONS, contentOptionsFromEnvironment } from './content.options';
import { ContentService } from './content.service';
import { ContentSettingsService } from './content.settings';
import { ContentFileSource } from './content-files';
import { ContentRevalidator } from './content-revalidate';
import { ContentManagementController, ContentPublicController } from './content.controller';

/** Existing composition-root database, auth, rate limiter and ConfigService are reused. */
@Module({ controllers: [ContentPublicController, ContentManagementController],
  providers: [{ provide: CONTENT_OPTIONS, useFactory: () => contentOptionsFromEnvironment(process.env) }, ContentService, ContentSettingsService, ContentFileSource, ContentRevalidator],
  exports: [ContentService, ContentSettingsService, ContentFileSource, ContentRevalidator] })
export class ContentModule {}
