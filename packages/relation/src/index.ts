export { ObjectTypeRegistry, CompositeObjectType, OBJECT_TYPE_IDS } from './object-type';
export type {
  ObjectType,
  PropertyDefinition,
  RelationDefinition,
  RelationType,
  RelationDirection,
  RelationObjectProvider,
} from './object-type';

export { RelationService, InMemoryRelationStore, generateRelationKey } from './relation.service';
export type { RelatedObject, RelationStore } from './relation.service';

export { ZuckerRelationModule, RELATION_STORE } from './relation.module';
