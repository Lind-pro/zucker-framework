import { ForbiddenException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, ApiKeyService } from '@zucker-framework/auth';
import { ACCOUNT_API_KEY_SCOPES } from '../accounts/api-key-authentication';
import { AccountApiKeysService, ACCOUNT_KEY_SCOPES } from './api-keys.service';

@Injectable()
export class AccountApiKeyAuthenticator implements CanActivate {
  private readonly guard: ApiKeyGuard;
  constructor(@Inject(ApiKeyService) keys: ApiKeyService, private readonly reflector: Reflector, private readonly accounts: AccountApiKeysService) {
    this.guard = new ApiKeyGuard(keys); // Missing keys fail closed; this is never a JWT fallback.
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(ACCOUNT_API_KEY_SCOPES, [context.getHandler(), context.getClass()]);
    if (!required?.length || required.some(scope => !ACCOUNT_KEY_SCOPES.includes(scope as typeof ACCOUNT_KEY_SCOPES[number]))) {
      throw new ForbiddenException('API key scope is not configured');
    }
    await this.guard.canActivate(context);
    const request = context.switchToHttp().getRequest<{ user: { id: string; username?: string }; apiKey: { scopes: string[] } }>();
    if (!required.every(scope => request.apiKey.scopes.includes(scope))) throw new ForbiddenException('API key scope is insufficient');
    const user = await this.accounts.ownProfile(request.user.id);
    request.user = { id: user.id, username: user.username };
    return true;
  }
}
