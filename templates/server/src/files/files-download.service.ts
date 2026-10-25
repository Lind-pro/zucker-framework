import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { FileAssetError } from '@zucker-framework/storage';
import { JwtService } from '@nestjs/jwt';
import { AccountService } from '../accounts/account.service';
import { FILES_TRANSFER_OPTIONS, type FilesTransferOptions } from './files-transfer.config';
import { FilesService } from './files.service';
export const FILE_DOWNLOAD_AUDIENCE = 'zucker:file-download';
export const FILE_DOWNLOAD_PURPOSE = 'private-file-download';
interface DownloadTicket { sub: string; sid: string; purpose: string; assetId: string; assetRevision: number; credentialVersion: number; iat: number; exp: number }
const invalid = () => new UnauthorizedException({ code: 'FILE_DOWNLOAD_INVALID_TOKEN', message: 'Download ticket is invalid or expired' });
@Injectable()
export class FilesDownloadService {
  constructor(private readonly files: FilesService, private readonly accounts: AccountService, private readonly jwt: JwtService,
    @Inject(FILES_TRANSFER_OPTIONS) private readonly options: FilesTransferOptions) {
    if (!Number.isSafeInteger(options.downloadTtlSeconds) || options.downloadTtlSeconds < 1 || options.downloadTtlSeconds > 300) throw new Error('Invalid file download lifetime');
  }
  async create(ownerId: string, sessionId: string, assetId: string) {
    const user = await this.accounts.currentUser(ownerId, sessionId), asset = await this.files.inspect(ownerId, assetId);
    if (asset.state !== 'ready') throw new ConflictException('Only ready files can receive a download ticket');
    const iat = Math.floor(Date.now() / 1000), exp = iat + this.options.downloadTtlSeconds;
    const token = await this.jwt.signAsync({ sub: ownerId, sid: sessionId, purpose: FILE_DOWNLOAD_PURPOSE, assetId,
      assetRevision: asset.revision, credentialVersion: Number(user.credentialVersion ?? 0), iat }, { algorithm: 'HS256', audience: FILE_DOWNLOAD_AUDIENCE, expiresIn: this.options.downloadTtlSeconds });
    return { url: `/api/files/${encodeURIComponent(asset.id)}/download?token=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString(), expiresInSeconds: this.options.downloadTtlSeconds };
  }
  async read(assetId: string, token: string) {
    let claims: DownloadTicket;
    try {
      if (!token || token.length > 4096) throw new Error();
      claims = await this.jwt.verifyAsync<DownloadTicket>(token, { algorithms: ['HS256'], audience: FILE_DOWNLOAD_AUDIENCE });
      const now = Math.floor(Date.now() / 1000);
      if (claims.purpose !== FILE_DOWNLOAD_PURPOSE || claims.assetId !== assetId || typeof claims.sub !== 'string' || !claims.sub || typeof claims.sid !== 'string' || !claims.sid
        || !Number.isSafeInteger(claims.assetRevision) || claims.assetRevision < 0 || !Number.isSafeInteger(claims.credentialVersion) || claims.credentialVersion < 0
        || !Number.isSafeInteger(claims.iat) || claims.iat > now + 5 || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp - claims.iat < 1 || claims.exp - claims.iat > 300) throw new Error();
    } catch { throw invalid(); }
    const authorize = async () => {
      const user = await this.accounts.currentUser(claims.sub, claims.sid);
      if (Number(user.credentialVersion ?? 0) !== claims.credentialVersion) throw invalid();
    };
    await authorize();
    const initial = await this.files.inspect(claims.sub, assetId);
    if (initial.state === 'deleted') throw new FileAssetError('ASSET_DELETED');
    if (initial.revision !== claims.assetRevision) throw new ConflictException({ code: 'FILE_DOWNLOAD_STALE', message: 'The file changed; create a new download ticket' });
    const result = await this.files.read(claims.sub, assetId);
    if (result.asset.revision !== claims.assetRevision) throw new ConflictException({ code: 'FILE_DOWNLOAD_STALE', message: 'The file changed while downloading' });
    await authorize(); if (Math.floor(Date.now() / 1000) >= claims.exp) throw invalid(); return result;
  }
}
