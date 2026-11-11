import { createManagementController } from '@zucker-framework/back-office/management';
import { ConnectionsService } from './connections.service';
import { MANAGEMENT_OPTIONS } from './management.config';
import { ManagementService } from './management.service';

/** `/management/*` back-office read models, credit grant and connection inventory (back-office host). */
export const ManagementController = createManagementController(MANAGEMENT_OPTIONS, { service: ManagementService, connections: ConnectionsService });
