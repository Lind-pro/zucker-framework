import { Module, DynamicModule, Global } from '@nestjs/common';
import { DictionaryService } from './dictionary.service';
import { DictionaryItemService } from './dictionary-item.service';
import { DictDefineRepository, CompositeDictDefineRepository } from './dict-define';

@Global()
@Module({})
export class ZuckerDictionaryModule {
  static forRoot(): DynamicModule {
    return {
      module: ZuckerDictionaryModule,
      providers: [
        DictionaryService,
        DictionaryItemService,
        DictDefineRepository,
        CompositeDictDefineRepository,
      ],
      exports: [
        DictionaryService,
        DictionaryItemService,
        DictDefineRepository,
        CompositeDictDefineRepository,
      ],
    };
  }
}
