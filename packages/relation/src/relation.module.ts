import { Module, Global, DynamicModule } from '@nestjs/common';
import { RelationService, RelationStore, InMemoryRelationStore } from './relation.service';
import { ObjectTypeRegistry } from './object-type';

export const RELATION_STORE = Symbol('RELATION_STORE');

@Global()
@Module({})
export class ZuckerRelationModule {
  static forRoot(store?: RelationStore): DynamicModule {
    const relationStore = store ?? new InMemoryRelationStore();

    return {
      module: ZuckerRelationModule,
      global: true,
      providers: [
        { provide: RELATION_STORE, useValue: relationStore },
        {
          provide: RelationService,
          useFactory: () => new RelationService(relationStore),
        },
        ObjectTypeRegistry,
      ],
      exports: [RelationService, ObjectTypeRegistry, RELATION_STORE],
    };
  }
}
