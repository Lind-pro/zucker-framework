import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';

export interface DataReference {
  dataType: string;
  dataId: string;
  referenceType: string;
  referenceId: string;
  referenceName?: string;
}

/**
 * Data reference provider SPI.
 * Mirrors Java DataReferenceProvider which extends Strategy.
 * Each provider handles one data type (identified by `type` / `getId()`).
 */
export interface DataReferenceProvider {
  /** The data type this provider handles (equivalent to Java Strategy.getId()). */
  type: string;
  /** Get references for a specific data item. Mirrors Java getReference(dataId). */
  getReferences(dataType: string, dataId: string): Promise<DataReference[]>;
  /** Get all references for this data type. Mirrors Java getReferences(). */
  getAllReferences?(): Promise<DataReference[]>;
}

/**
 * Typed exception thrown when data cannot be deleted due to active references.
 * Mirrors Java DataReferencedException (HTTP 400 / error.data.referenced).
 */
export class DataReferencedException extends HttpException {
  public readonly dataType: string;
  public readonly dataId: string;
  public readonly referenceList: DataReference[];

  constructor(dataType: string, dataId: string, referenceList: DataReference[]) {
    const refDescriptions = referenceList
      .map((r) => r.referenceName ?? `${r.referenceType}:${r.referenceId}`)
      .join(', ');
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: `Data ${dataType}:${dataId} is referenced by: ${refDescriptions}`,
        error: 'error.data.referenced',
        dataType,
        dataId,
        referenceList,
      },
      HttpStatus.BAD_REQUEST,
    );
    this.dataType = dataType;
    this.dataId = dataId;
    this.referenceList = referenceList;
  }
}

/** Well-known data type constants. Mirrors Java DataReferenceManager constants. */
export const DATA_REFERENCE_TYPES = {
  DEVICE_GATEWAY: 'device-gateway',
  NETWORK: 'network',
  RELATION: 'relation',
  PROTOCOL: 'protocol',
} as const;

/**
 * Data reference manager — collects references from all registered providers.
 * Mirrors Java DefaultDataReferenceManager which extends StaticStrategyManager.
 */
@Injectable()
export class DataReferenceManager {
  private readonly logger = new Logger(DataReferenceManager.name);
  private providers: DataReferenceProvider[] = [];

  registerProvider(provider: DataReferenceProvider): void {
    this.providers.push(provider);
    this.logger.log(`Reference provider registered: ${provider.type}`);
  }

  unregisterProvider(type: string): void {
    this.providers = this.providers.filter((p) => p.type !== type);
  }

  /** Get a registered provider by type. */
  getProvider(type: string): DataReferenceProvider | undefined {
    return this.providers.find((p) => p.type === type);
  }

  /** Get all registered providers. */
  getProviders(): DataReferenceProvider[] {
    return [...this.providers];
  }

  /**
   * Get references for a specific data item across all providers.
   * Mirrors Java DefaultDataReferenceManager.getReferences(dataType, dataId).
   */
  async getReferences(dataType: string, dataId: string): Promise<DataReference[]> {
    if (!dataType || !dataId) return [];
    const results: DataReference[] = [];
    for (const provider of this.providers) {
      const refs = await provider.getReferences(dataType, dataId);
      results.push(...refs);
    }
    return results;
  }

  /**
   * Get all references for a data type (no specific dataId filter).
   * Mirrors Java DefaultDataReferenceManager.getReferences(dataType).
   */
  async getAllReferences(dataType: string): Promise<DataReference[]> {
    const provider = this.providers.find((p) => p.type === dataType);
    if (!provider || !provider.getAllReferences) {
      return [];
    }
    return provider.getAllReferences();
  }

  /**
   * Check if a data item is referenced. Short-circuits on first found reference.
   * Mirrors Java DefaultDataReferenceManager.isReferenced() which uses hasElements().
   */
  async hasReferences(dataType: string, dataId: string): Promise<boolean> {
    for (const provider of this.providers) {
      const refs = await provider.getReferences(dataType, dataId);
      if (refs.length > 0) return true;
    }
    return false;
  }

  /**
   * Assert data is not referenced; throws DataReferencedException if it is.
   * Mirrors Java DataReferenceManager.assertNotReferenced().
   */
  async assertNoReferences(dataType: string, dataId: string): Promise<void> {
    const refs = await this.getReferences(dataType, dataId);
    if (refs.length > 0) {
      throw new DataReferencedException(dataType, dataId, refs);
    }
  }
}
