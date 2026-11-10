import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { ZuckerAuthModule } from '@zucker-framework/auth';
import { UsersController } from './users.controller';
import { ADMIN_USERS_OPTIONS, ADMIN_USER_HOOKS, type AdminUserHooks, type UsersAdminOptions } from './users.options';

export interface UsersAdminModuleOptions extends UsersAdminOptions {
  /** Consumer hooks (session revocation after password/status/e-mail changes, deletion cleanup). */
  hooks?: Type<AdminUserHooks>;
}

@Module({
  imports: [ZuckerAuthModule],
  controllers: [UsersController],
})
export class ZuckerUsersAdminModule {
  static forRoot(options: UsersAdminModuleOptions = {}): DynamicModule {
    const { hooks, ...settings } = options;
    const providers: Provider[] = [{ provide: ADMIN_USERS_OPTIONS, useValue: settings }];
    if (hooks) providers.push({ provide: ADMIN_USER_HOOKS, useClass: hooks });
    return { module: ZuckerUsersAdminModule, imports: [ZuckerAuthModule], controllers: [UsersController], providers };
  }
}
