import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataReferenceManager, DataReferencedException } from './reference-manager';
import { PREVENT_DELETE_IF_REFERENCED } from './decorators';

/**
 * Guard that prevents deletion when data is referenced.
 * Uses DataReferencedException (HTTP 400) instead of ForbiddenException,
 * matching Java DataReferenceManager.assertNotReferenced() semantics.
 */
@Injectable()
export class ReferenceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly referenceManager: DataReferenceManager,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const dataType = this.reflector.get<string>(
      PREVENT_DELETE_IF_REFERENCED,
      context.getHandler(),
    );
    if (!dataType) return true;

    const request = context.switchToHttp().getRequest();
    const ids = collectTargetIds(request);
    if (ids.length === 0) return true;

    // Use assertNoReferences which throws DataReferencedException (HTTP 400)
    // matching Java's assertNotReferenced() semantics.
    // Note: this is a pre-check; a reference created between the check and the
    // delete is not caught here — enforce hard guarantees with DB constraints.
    for (const id of ids) {
      await this.referenceManager.assertNoReferences(dataType, id);
    }

    return true;
  }
}

/**
 * Ids targeted by a delete request: `params.id`, a batch body `{ ids: [...] }` and
 * the crud batch-delete `where.id` / `where.id.in`. Other `where` filters cannot be
 * resolved to ids here and are not checked.
 */
function collectTargetIds(request: { params?: Record<string, unknown>; body?: unknown }): string[] {
  const ids = new Set<string>();
  const paramId = request.params?.id;
  if (typeof paramId === 'string' && paramId) ids.add(paramId);
  const add = (value: unknown) => {
    if ((typeof value === 'string' && value) || typeof value === 'number') ids.add(String(value));
  };
  const body = request.body as { ids?: unknown; where?: { id?: unknown } } | undefined;
  if (body && Array.isArray(body.ids)) body.ids.forEach(add);
  // crud `DELETE batch` body: { where: { id: 'x' } } or { where: { id: { in: [...] } } }
  const whereId = body?.where?.id;
  if (typeof whereId === 'string' || typeof whereId === 'number') add(whereId);
  else if (whereId && typeof whereId === 'object' && Array.isArray((whereId as { in?: unknown }).in)) {
    ((whereId as { in: unknown[] }).in).forEach(add);
  }
  return [...ids];
}
