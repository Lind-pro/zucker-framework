import { Module } from '@nestjs/common';
import { DictionaryController } from './dictionary.controller';

/**
 * ZuckerDictionaryAdminModule
 *
 * DictionaryService and DictionaryItemService are provided globally by
 * ZuckerDictionaryModule.forRoot() — no need to re-declare them here.
 */
@Module({
  controllers: [DictionaryController],
})
export class ZuckerDictionaryAdminModule {}
