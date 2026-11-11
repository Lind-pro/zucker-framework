import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { FileManager, UploadOptions, UploadResult, FileInfo } from './storage.interface';

export type S3ObjectAclMode = 'object-acl' | 'none';
export type S3UploadUrlMode = 'signed' | 'public-only';

export interface S3StorageOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  bucket: string;
  publicUrl?: string;
  forcePathStyle?: boolean;
  objectAclMode?: S3ObjectAclMode;
  uploadUrlMode?: S3UploadUrlMode;
  signedUrlExpiresIn?: number;
  /**
   * Bytes per multipart part for `uploadStream` (default 8 MiB, at least 5 MiB, the S3 minimum for
   * every part but the last, and at most 5 GiB). At most one part is buffered at a time.
   */
  partSize?: number;
}

const MiB = 1024 * 1024;
export const S3_DEFAULT_PART_SIZE = 8 * MiB;
export const S3_MIN_PART_SIZE = 5 * MiB;
export const S3_MAX_PART_SIZE = 5 * 1024 * MiB;
/** S3 refuses part numbers above 10 000. */
const S3_MAX_PARTS = 10_000;

@Injectable()
export class S3Storage implements FileManager, OnModuleDestroy {
  private readonly logger = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly objectAclMode: S3ObjectAclMode;
  private readonly uploadUrlMode: S3UploadUrlMode;
  private readonly signedUrlExpiresIn: number;
  private readonly partSize: number;
  readonly providerType = 's3' as const;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.publicUrl = options.publicUrl ?? '';
    this.objectAclMode = options.objectAclMode ?? 'object-acl';
    this.uploadUrlMode = options.uploadUrlMode ?? 'signed';
    this.signedUrlExpiresIn = options.signedUrlExpiresIn ?? 3600;
    this.partSize = options.partSize ?? S3_DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(this.partSize) || this.partSize < S3_MIN_PART_SIZE || this.partSize > S3_MAX_PART_SIZE) {
      throw new Error(`S3 partSize must be an integer between ${S3_MIN_PART_SIZE} and ${S3_MAX_PART_SIZE} bytes`);
    }

    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      endpoint: options.endpoint,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    });

    this.logger.log('S3 storage initialized');
  }

  onModuleDestroy(): void {
    this.client.destroy();
    this.logger.log('S3 客户端已关闭');
  }

  isConfigured(): boolean {
    return true;
  }

  async upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult> {
    const input = this.objectInput(key, options);
    await this.client.send(new PutObjectCommand({ ...input, Body: buffer }));
    return this.result(key, buffer.length);
  }

  /**
   * Streams into S3 without holding the whole object: bytes are cut into `partSize` parts and sent
   * one part at a time (CreateMultipartUpload, sequential UploadPart, CompleteMultipartUpload). A
   * stream that ends within the first part is sent as one PutObject. A stream error or any failed
   * request aborts the multipart upload (no billed, invisible parts are left behind) and rethrows.
   * `size` is the number of bytes sent.
   */
  async uploadStream(
    stream: Readable,
    key: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const input = this.objectInput(key, options);
    const partSize = this.partSize;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let uploadId: string | undefined;
    const parts: CompletedPart[] = [];
    let sent = 0;

    const sendPart = async () => {
      if (uploadId === undefined) {
        const created = await this.client.send(new CreateMultipartUploadCommand(input));
        if (!created.UploadId) throw new Error('S3 did not return a multipart upload id');
        uploadId = created.UploadId;
      }
      const partNumber = parts.length + 1;
      if (partNumber > S3_MAX_PARTS) throw new Error('Stream exceeds the S3 multipart part limit; raise partSize');
      const body = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      // Release the chunk references before the request so only this part's bytes stay reachable.
      pending = [];
      const length = pendingBytes;
      pendingBytes = 0;
      const response = await this.client.send(new UploadPartCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: length,
      }));
      if (!response.ETag) throw new Error('S3 did not return an ETag for an uploaded part');
      // Echo any checksum S3 computed for the part; Complete must repeat it when one was recorded.
      parts.push({
        PartNumber: partNumber, ETag: response.ETag,
        ...(response.ChecksumCRC32 ? { ChecksumCRC32: response.ChecksumCRC32 } : {}),
        ...(response.ChecksumCRC32C ? { ChecksumCRC32C: response.ChecksumCRC32C } : {}),
        ...(response.ChecksumCRC64NVME ? { ChecksumCRC64NVME: response.ChecksumCRC64NVME } : {}),
        ...(response.ChecksumSHA1 ? { ChecksumSHA1: response.ChecksumSHA1 } : {}),
        ...(response.ChecksumSHA256 ? { ChecksumSHA256: response.ChecksumSHA256 } : {}),
      });
      sent += length;
    };

    try {
      for await (const chunk of stream) {
        let buffer = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
        while (buffer.length > 0) {
          // A full part is sent only once more bytes exist, so a stream of exactly one part is one PutObject.
          if (pendingBytes === partSize) await sendPart();
          const take = Math.min(partSize - pendingBytes, buffer.length);
          pending.push(take === buffer.length ? buffer : buffer.subarray(0, take));
          pendingBytes += take;
          buffer = buffer.subarray(take);
        }
      }

      if (uploadId === undefined) {
        const body = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        pending = [];
        await this.client.send(new PutObjectCommand({ ...input, Body: body }));
        return this.result(key, body.length);
      }
      if (pendingBytes > 0) await sendPart();
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
      }));
      return this.result(key, sent);
    } catch (error) {
      pending = [];
      if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
      if (uploadId !== undefined) {
        try {
          await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
        } catch {
          // The bucket lifecycle rule for incomplete multipart uploads is the backstop.
          this.logger.warn('S3 multipart upload could not be aborted');
        }
      }
      throw error;
    }
  }

  private objectInput(key: string, options?: UploadOptions) {
    if (this.objectAclMode === 'none' && options?.acl === 'public-read') {
      throw new Error('Object-level public ACL is disabled for this storage provider');
    }
    return {
      Bucket: this.bucket,
      Key: key,
      ContentType: options?.contentType ?? 'application/octet-stream',
      Metadata: options?.metadata,
      ...(this.objectAclMode === 'object-acl' && options?.acl ? { ACL: options.acl } : {}),
    };
  }

  private async result(key: string, size: number): Promise<UploadResult> {
    return {
      key,
      url: this.publicUrl
        ? await this.getPublicUrl(key)
        : this.uploadUrlMode === 'signed'
          ? await this.getDownloadUrl(key)
          : '',
      size,
    };
  }

  async download(key: string): Promise<{ stream: Readable; size: number }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error('Stored object response had no body');
    }
    if (!(response.Body instanceof Readable)) {
      throw new Error('Stored object response must be a Node readable stream');
    }

    return {
      stream: response.Body,
      size: response.ContentLength ?? 0,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (error: unknown) {
      const s3Err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (s3Err.name === 'NotFound' || s3Err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async getPublicUrl(key: string): Promise<string> {
    if (!this.publicUrl) {
      throw new Error('No public URL is configured for this storage provider');
    }
    return `${this.publicUrl}/${encodeKeyPath(key)}`;
  }

  async getDownloadUrl(key: string, expiresIn = this.signedUrlExpiresIn): Promise<string> {
    if (this.publicUrl) return this.getPublicUrl(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn },
    );
  }

  async list(prefix: string): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      files.push(
        ...(response.Contents ?? []).map((item) => ({
          key: item.Key ?? '',
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? new Date(),
        })),
      );
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return files;
  }

  async getFileInfo(key: string): Promise<FileInfo | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return {
        key,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified ?? new Date(),
        contentType: response.ContentType,
      };
    } catch (error: unknown) {
      const s3Err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (s3Err.name === 'NotFound' || s3Err.$metadata?.httpStatusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeKeyPath(sourceKey)}`,
        Key: destKey,
      }),
    );
  }

  async move(sourceKey: string, destKey: string): Promise<void> {
    await this.copy(sourceKey, destKey);
    await this.delete(sourceKey);
  }
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
