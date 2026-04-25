import { Module, Global } from '@nestjs/common';
import { DataReferenceManager } from './reference-manager';
import { ReferenceGuard } from './reference.guard';
import { OrphanCleanupService } from './orphan-cleanup.service';

@Global()
@Module({
  providers: [DataReferenceManager, ReferenceGuard, OrphanCleanupService],
  exports: [DataReferenceManager, ReferenceGuard, OrphanCleanupService],
})
export class ZuckerReferenceModule {}
