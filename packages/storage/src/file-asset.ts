import type { BufferedObjectStore, VerifiedStorageMetadata } from './verified-object-transfer';

export type FileAssetState = 'pending' | 'ready' | 'deleted';
export type FileAssetAction = 'upload' | 'read' | 'inspect' | 'recover' | 'delete';

/** Immutable request identity. Scope is derived from authenticated host context. */
export interface FileAssetReservation extends VerifiedStorageMetadata {
  id: string;
  scope: string;
  idempotencyKey: string;
  objectKey: string;
  fileName: string;
  createdAt: number;
}

export interface FileAssetMutation {
  state: FileAssetState;
  updatedAt: number;
  deletedAt: number | null;
  cleanupStatus: 'pending' | 'confirmed' | null;
  /** Last observed absence, not proof that an earlier remote write cannot arrive later. */
  cleanupConfirmedAt: number | null;
}

export interface FileAsset extends FileAssetReservation, FileAssetMutation {
  revision: number;
}

/**
 * Consumer-owned durable metadata port; no default in-memory implementation.
 * reserve is atomic under UNIQUE(scope, idempotencyKey), returning the existing
 * immutable record on conflict. New rows start pending at revision 0, with null
 * deletion/cleanup fields and updatedAt = createdAt. id/objectKey are unique.
 * Reads and CAS are scoped; CAS updates only the mutable fields and increments
 * revision atomically. Deleted rows are permanent tombstones, never reused.
 * Database errors must reject, never be translated to missing rows or success.
 */
export interface FileAssetRepository {
  reserve(input: FileAssetReservation): Promise<FileAsset>;
  get(scope: string, id: string): Promise<FileAsset | null>;
  compareAndSwap(scope: string, id: string, revision: number, update: FileAssetMutation): Promise<FileAsset | null>;
}

/**
 * Private, bounded object IO. exists=false means authoritative absence; permission,
 * network and unknown outcomes reject. delete is idempotent for missing objects.
 * Objects use dedicated keys and must not be modified outside this asset service.
 */
export interface PrivateFileObjectStore extends BufferedObjectStore {
  delete(key: string): Promise<void>;
}

export interface FileAssetAccessRequest {
  scope: string;
  action: FileAssetAction;
  assetId?: string;
}

export interface PrivateFileAssetOptions<TContext> {
  repository: FileAssetRepository;
  objects: PrivateFileObjectStore;
  /** Required host policy. Never authorize a scope merely because a client supplied it. */
  authorize(context: TContext, request: FileAssetAccessRequest): boolean | Promise<boolean>;
  detectMimeType(body: Buffer): string;
  maxObjectBytes: number;
  now?: () => number;
}

export type FileAssetErrorCode =
  | 'INVALID_ARGUMENT' | 'FORBIDDEN' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT'
  | 'ASSET_DELETED' | 'ASSET_NOT_READY' | 'CONTENT_UNAVAILABLE'
  | 'UPLOAD_UNVERIFIED' | 'DELETE_UNVERIFIED' | 'METADATA_UNAVAILABLE' | 'CONCURRENT_CHANGE';

/** Stable, non-sensitive errors; provider messages/credentials are not persisted. */
export class FileAssetError extends Error {
  constructor(readonly code: FileAssetErrorCode) {
    super(code);
    this.name = 'FileAssetError';
  }
}
