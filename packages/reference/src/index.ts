export {
  type DataReference,
  type DataReferenceProvider,
  DataReferenceManager,
  DataReferencedException,
  DATA_REFERENCE_TYPES,
} from './reference-manager';

export {
  PREVENT_DELETE_IF_REFERENCED,
  PreventDeleteIfReferenced,
} from './decorators';

export { ReferenceGuard } from './reference.guard';

export {
  CascadeDeleteStrategy,
  CASCADE_DELETE_KEY,
} from './cascade-delete';
export type { CascadeDeleteConfig, CascadeAction } from './cascade-delete';

export { OrphanCleanupService } from './orphan-cleanup.service';
export type { OrphanChecker } from './orphan-cleanup.service';

export {
  REFERENCE_ADDED_EVENT,
  REFERENCE_REMOVED_EVENT,
} from './reference-events';
export type { ReferenceChangeEvent } from './reference-events';

export { ZuckerReferenceModule } from './reference.module';
