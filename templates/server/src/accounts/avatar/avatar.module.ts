import { Module } from '@nestjs/common';
import { FilesModule } from '../../files/files.module';
import { AccountAvatarController } from './avatar.controller';
import { AccountAvatarService } from './avatar.service';

/** Optional root consumer: standalone account authentication does not require storage or image decoding. */
@Module({ imports: [FilesModule], controllers: [AccountAvatarController], providers: [AccountAvatarService], exports: [AccountAvatarService] })
export class AccountAvatarModule {}
