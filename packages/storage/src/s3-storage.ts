import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ReadStream } from 'fs';
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
}

@Injectable()
export class S3Storage implements FileManager, OnModuleDestroy {
  private readonly logger = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly objectAclMode: S3ObjectAclMode;
  private readonly uploadUrlMode: S3UploadUrlMode;
  private readonly signedUrlExpiresIn: number;
  readonly providerType = 's3' as const;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.publicUrl = options.publicUrl ?? '';
    this.objectAclMode = options.objectAclMode ?? 'object-acl';
    this.uploadUrlMode = options.uploadUrlMode ?? 'signed';
    this.signedUrlExpiresIn = options.signedUrlExpiresIn ?? 3600;

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
    if (this.objectAclMode === 'none' && options?.acl === 'public-read') {
      throw new Error('Object-level public ACL is disabled for this storage provider');
    }

    const input = {
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: options?.contentType ?? 'application/octet-stream',
      Metadata: options?.metadata,
      ...(this.objectAclMode === 'object-acl' && options?.acl ? { ACL: options.acl } : {}),
    };
    await this.client.send(
      new PutObjectCommand(input),
    );

    return {
      key,
      url: this.publicUrl
        ? await this.getPublicUrl(key)
        : this.uploadUrlMode === 'signed'
          ? await this.getDownloadUrl(key)
          : '',
      size: buffer.length,
    };
  }

  async uploadStream(
    stream: ReadStream,
    key: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return this.upload(Buffer.concat(chunks), key, options);
  }

  async download(key: string): Promise<{ stream: ReadStream; size: number }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error('Stored object response had no body');
    }

    return {
      stream: response.Body as unknown as ReadStream,
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
