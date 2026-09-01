export interface PropertyDefinition {
  key: string;
  name: string;
  type: string;
  required?: boolean;
}

export type RelationType = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
export type RelationDirection = 'forward' | 'reverse' | 'bidirectional';

export interface RelationDefinition {
  id: string;
  name: string;
  targetType: string;
  relationType: RelationType;
  direction: RelationDirection;
  /** Extra metadata. Mirrors Java Relation.expands. */
  expands?: Record<string, unknown>;
}

/**
 * Object type definition.
 * Mirrors Java ObjectType with description, expands, and relatedTypes.
 */
export interface ObjectType {
  id: string;
  name: string;
  /** Description of the object type. Mirrors Java ObjectType.getDescription(). */
  description?: string;
  properties: PropertyDefinition[];
  relations: RelationDefinition[];
  /** Related object types. Mirrors Java ObjectType.getRelatedTypes(). */
  relatedTypes?: ObjectType[];
  /** Extension metadata. Mirrors Java ObjectType.getExpands(). */
  expands?: Record<string, unknown>;
}

/**
 * Composite object type — merges two ObjectTypes, with main taking precedence
 * for scalar fields and both contributing to list fields.
 * Mirrors Java CompositeObjectType.
 */
export class CompositeObjectType implements ObjectType {
  public readonly id: string;
  public readonly name: string;
  public readonly description?: string;
  public readonly expands?: Record<string, unknown>;

  constructor(
    private readonly main: ObjectType,
    private readonly second: ObjectType,
  ) {
    this.id = main.id;
    this.name = main.name;
    this.description = main.description ?? second.description;
    this.expands = {
      ...(second.expands ?? {}),
      ...(main.expands ?? {}),
    };
  }

  get properties(): PropertyDefinition[] {
    return [...(this.main.properties ?? []), ...(this.second.properties ?? [])];
  }

  get relations(): RelationDefinition[] {
    return [...(this.main.relations ?? []), ...(this.second.relations ?? [])];
  }

  get relatedTypes(): ObjectType[] {
    return [...(this.main.relatedTypes ?? []), ...(this.second.relatedTypes ?? [])];
  }
}

/** Well-known object type ids. Mirrors Java RelationObjectProvider constants. */
export const OBJECT_TYPE_IDS = {
  USER: 'user',
  DEVICE: 'device',
} as const;

/**
 * Relation object provider SPI.
 * Mirrors Java RelationObjectProvider interface.
 */
export interface RelationObjectProvider {
  /** The object type id this provider handles. */
  getTypeId(): string;
  /** Get the full ObjectType definition. */
  getType(): Promise<ObjectType>;
  /** Get property values for a specific object instance. */
  getProperties?(id: string): Promise<Record<string, unknown>>;
}

/**
 * 对象类型注册中心
 */
export class ObjectTypeRegistry {
  private types = new Map<string, ObjectType>();
  private objectProviders = new Map<string, RelationObjectProvider>();

  register(type: ObjectType): void {
    this.types.set(type.id, type);
  }

  unregister(id: string): void {
    this.types.delete(id);
  }

  get(id: string): ObjectType | undefined {
    return this.types.get(id);
  }

  getAll(): ObjectType[] {
    return Array.from(this.types.values());
  }

  getRelations(typeId: string): RelationDefinition[] {
    return this.types.get(typeId)?.relations ?? [];
  }

  /**
   * Get relations filtered by target type.
   * Mirrors Java ObjectType.getRelations(String type).
   */
  getRelationsForTarget(typeId: string, targetType: string): RelationDefinition[] {
    return this.getRelations(typeId).filter((r) => r.targetType === targetType);
  }

  /** Register a RelationObjectProvider. */
  registerProvider(provider: RelationObjectProvider): void {
    this.objectProviders.set(provider.getTypeId(), provider);
  }

  /** Unregister a RelationObjectProvider. */
  unregisterProvider(typeId: string): void {
    this.objectProviders.delete(typeId);
  }

  /** Get a RelationObjectProvider by type id. */
  getProvider(typeId: string): RelationObjectProvider | undefined {
    return this.objectProviders.get(typeId);
  }

  /** Get all registered RelationObjectProviders. */
  getAllProviders(): RelationObjectProvider[] {
    return Array.from(this.objectProviders.values());
  }
}
