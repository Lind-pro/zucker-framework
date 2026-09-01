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
    const id = request.params?.id;
    if (!id) return true;

    // Use assertNoReferences which throws DataReferencedException (HTTP 400)
    // matching Java's assertNotReferenced() semantics
    await this.referenceManager.assertNoReferences(dataType, id);

    return true;
  }
}
