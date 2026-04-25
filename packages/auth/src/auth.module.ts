import {
  Global,
  Module,
  type DynamicModule,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { DatabaseAdapter } from '@zucker/core';
import type { ICache } from '@zucker/cache';
import type { DimensionProvider, ZuckerAuthModuleOptions } from './interfaces';
import { DIMENSION_PROVIDERS } from './interfaces';
import { PermissionService } from './services/permission.service';
import { PermissionScannerService } from './services/permission-scanner.service';
import { DimensionService } from './services/dimension.service';
import { RoleHierarchyService } from './services/role-hierarchy.service';
import { TokenService, TOKEN_CACHE } from './services/token.service';
import { MenuService } from './services/menu.service';
import { ThirdPartyAccountService } from './services/third-party-account.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { DataPermissionGuard, DATABASE_ADAPTER } from './guards/data-permission.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { MenuController } from './controllers/menu.controller';
import { ThirdPartyAccountController } from './controllers/third-party-account.controller';
import { AuthorizationController, AUTHENTICATION_MANAGER } from './controllers/authorization.controller';
import { BcryptEncoder } from './password/bcrypt-encoder';
import { UserSettingsService } from './services/user-settings.service';
import { UserService } from './services/user.service';
import { RoleService } from './services/role.service';
import { AuthorizationSettingService } from './services/authorization-setting.service';
import { DimensionUserService } from './services/dimension-user.service';
import { PermissionSyncService } from './services/permission-sync.service';
import { TwoFactorService, TWO_FACTOR_PROVIDERS } from './two-factor/two-factor.service';

// Data Access Handlers
import { DATA_ACCESS_HANDLERS } from './data-access/data-access-handler';
import { OwnCreatedDataAccessHandler } from './data-access/own-created.handler';
import { FieldFilterDataAccessHandler } from './data-access/field-filter.handler';
import { ScopeDataAccessHandler } from './data-access/scope.handler';
import { DimensionDataAccessHandler } from './data-access/dimension.handler';

// Authentication
import { AuthenticationHolder } from './authentication/authentication-holder';
import { AUTHENTICATION_SUPPLIERS } from './authentication/authentication-supplier';

export interface ZuckerAuthModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => ZuckerAuthModuleOptions | Promise<ZuckerAuthModuleOptions>;
  useClass?: Type<ZuckerAuthModuleOptionsFactory>;
  useExisting?: Type<ZuckerAuthModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface ZuckerAuthModuleOptionsFactory {
  createAuthOptions(): ZuckerAuthModuleOptions | Promise<ZuckerAuthModuleOptions>;
}

const AUTH_MODULE_OPTIONS = Symbol('AUTH_MODULE_OPTIONS');

/**
 * Resolve the JWT secret from options, enforcing explicit configuration
 * in non-development environments.
 */
function resolveJwtSecret(options: ZuckerAuthModuleOptions): string {
  if (options.jwtSecret) return options.jwtSecret;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    throw new Error(
      '[ZuckerAuthModule] jwtSecret is required in production/staging. ' +
      'Set it via ZuckerAuthModule.forRoot({ jwtSecret }) or the JWT_SECRET environment variable.',
    );
  }

  // Development fallback — logged as warning so it's never silent
  const logger = new (require('@nestjs/common').Logger)('ZuckerAuthModule');
  logger.warn(
    'Using insecure default JWT secret. Set jwtSecret for production use.',
  );
  return '__zucker_dev_only_secret__';
}

/**
 * All exports shared by forRoot and forRootAsync.
 * Maintaining a single list prevents drift between the two entry points.
 */
const MODULE_EXPORTS = [
  PermissionService,
  PermissionScannerService,
  DimensionService,
  RoleHierarchyService,
  TokenService,
  MenuService,
  ThirdPartyAccountService,
  AuthenticationHolder,
  JwtAuthGuard,
  PermissionsGuard,
  DataPermissionGuard,
  JwtStrategy,
  JwtModule,
  PassportModule,
  DATA_ACCESS_HANDLERS,
  OwnCreatedDataAccessHandler,
  FieldFilterDataAccessHandler,
  ScopeDataAccessHandler,
  DimensionDataAccessHandler,
  UserService,
  RoleService,
  AuthorizationSettingService,
  DimensionUserService,
  PermissionSyncService,
  UserSettingsService,
  TwoFactorService,
];

const MODULE_CONTROLLERS = [MenuController, ThirdPartyAccountController, AuthorizationController];

@Global()
@Module({})
export class ZuckerAuthModule {
  /**
   * Build the common provider list shared by both forRoot and forRootAsync.
   *
   * @param optionsToken - injection token that resolves to ZuckerAuthModuleOptions
   *                       (AUTH_MODULE_OPTIONS for async, or a literal-value provider for sync)
   */
  private static buildProviders(optionsToken: InjectionToken): Provider[] {
    return [
      // --- JWT strategy ---
      {
        provide: JwtStrategy,
        useFactory: (opts: ZuckerAuthModuleOptions) =>
          new JwtStrategy(resolveJwtSecret(opts)),
        inject: [optionsToken],
      },

      // --- Services that need DatabaseAdapter ---
      {
        provide: RoleHierarchyService,
        useFactory: (db: DatabaseAdapter) => new RoleHierarchyService(db),
        inject: [DATABASE_ADAPTER],
      },
      {
        provide: PermissionService,
        useFactory: (db: DatabaseAdapter, roleHierarchy: RoleHierarchyService) => {
          const svc = new PermissionService(db);
          svc.setRoleHierarchyService(roleHierarchy);
          return svc;
        },
        inject: [DATABASE_ADAPTER, RoleHierarchyService],
      },
      {
        provide: MenuService,
        useFactory: (db: DatabaseAdapter) => new MenuService(db),
        inject: [DATABASE_ADAPTER],
      },
      {
        provide: ThirdPartyAccountService,
        useFactory: (db: DatabaseAdapter) => new ThirdPartyAccountService(db),
        inject: [DATABASE_ADAPTER],
      },

      // --- TokenService with optional cache ---
      {
        provide: TokenService,
        useFactory: (opts: ZuckerAuthModuleOptions, cache: ICache | null, jwtSvc: JwtService) => {
          const svc = new TokenService(cache || undefined, jwtSvc);
          if (opts.maxActiveSessions) {
            svc.configure({ maxActiveSessions: opts.maxActiveSessions });
          }
          return svc;
        },
        inject: [optionsToken, TOKEN_CACHE, JwtService],
      },

      // --- User / Role / Authorization ---
      {
        provide: UserService,
        useFactory: (db: DatabaseAdapter) => new UserService(db),
        inject: [DATABASE_ADAPTER],
      },
      {
        provide: RoleService,
        useFactory: (db: DatabaseAdapter) => new RoleService(db),
        inject: [DATABASE_ADAPTER],
      },
      {
        provide: AuthorizationSettingService,
        useFactory: (db: DatabaseAdapter, dimensionService: DimensionService) =>
          new AuthorizationSettingService(db, dimensionService),
        inject: [DATABASE_ADAPTER, DimensionService],
      },
      {
        provide: DimensionUserService,
        useFactory: (db: DatabaseAdapter) => new DimensionUserService(db),
        inject: [DATABASE_ADAPTER],
      },
      {
        provide: PermissionSyncService,
        useFactory: (db: DatabaseAdapter, scanner: PermissionScannerService) =>
          new PermissionSyncService(db, scanner),
        inject: [DATABASE_ADAPTER, PermissionScannerService],
      },
      {
        provide: UserSettingsService,
        useFactory: (db: DatabaseAdapter) => new UserSettingsService(db),
        inject: [DATABASE_ADAPTER],
      },

      // --- Two-Factor ---
      TwoFactorService,
      { provide: TWO_FACTOR_PROVIDERS, useValue: null },

      // --- Services without external deps ---
      DimensionService,
      PermissionScannerService,

      // --- Data Access Handlers ---
      OwnCreatedDataAccessHandler,
      FieldFilterDataAccessHandler,
      ScopeDataAccessHandler,
      DimensionDataAccessHandler,
      {
        provide: DATA_ACCESS_HANDLERS,
        useFactory: (
          ownCreated: OwnCreatedDataAccessHandler,
          fieldFilter: FieldFilterDataAccessHandler,
          scope: ScopeDataAccessHandler,
          dimension: DimensionDataAccessHandler,
        ) => [ownCreated, fieldFilter, scope, dimension],
        inject: [
          OwnCreatedDataAccessHandler,
          FieldFilterDataAccessHandler,
          ScopeDataAccessHandler,
          DimensionDataAccessHandler,
        ],
      },

      // --- Authentication ---
      AuthenticationHolder,
      { provide: DIMENSION_PROVIDERS, useValue: null },
      { provide: AUTHENTICATION_SUPPLIERS, useValue: null },

      // --- Guards ---
      JwtAuthGuard,
      PermissionsGuard,
      DataPermissionGuard,

      // --- AuthenticationManager ---
      {
        provide: AUTHENTICATION_MANAGER,
        useFactory: (userService: UserService) => {
          const encoder = new BcryptEncoder();
          return {
            async authenticate(username: string, password: string) {
              const user = await userService.findByUsername(username);
              if (!user) return null;
              if (!user.password) return null;
              const ok = await encoder.matches(password, user.password);
              return ok ? user : null;
            },
          };
        },
        inject: [UserService],
      },
    ];
  }

  /**
   * Build option-specific providers (cache, dimensions) that differ
   * between forRoot (has direct options) and forRootAsync (reads from token).
   */
  private static buildOptionSpecificProviders(
    options: ZuckerAuthModuleOptions,
  ): Provider[] {
    const providers: Provider[] = [];

    // Token cache (optional injection)
    if (options.cacheProvider) {
      providers.push({ provide: TOKEN_CACHE, useExisting: options.cacheProvider });
    } else {
      providers.push({ provide: TOKEN_CACHE, useValue: null });
    }

    // Dimension providers
    if (options.dimensionProviders?.length) {
      providers.push({
        provide: DIMENSION_PROVIDERS,
        useFactory: (...instances: DimensionProvider[]) => instances,
        inject: options.dimensionProviders as Type<DimensionProvider>[],
      });
      providers.push(...(options.dimensionProviders as Type<DimensionProvider>[]));
    }

    return providers;
  }

  static forRoot(options: ZuckerAuthModuleOptions = {}): DynamicModule {
    const jwtSecret = resolveJwtSecret(options);

    // Sync options: provide a literal-value token so buildProviders can inject it
    const optionsProvider: Provider = {
      provide: AUTH_MODULE_OPTIONS,
      useValue: options,
    };

    return {
      module: ZuckerAuthModule,
      imports: [
        DiscoveryModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: jwtSecret,
          signOptions: { expiresIn: '7d' },
        }),
      ],
      controllers: MODULE_CONTROLLERS,
      providers: [
        optionsProvider,
        ...this.buildProviders(AUTH_MODULE_OPTIONS),
        ...this.buildOptionSpecificProviders(options),
      ],
      exports: MODULE_EXPORTS,
    };
  }

  static forRootAsync(asyncOptions: ZuckerAuthModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(asyncOptions);

    return {
      module: ZuckerAuthModule,
      imports: [
        ...(asyncOptions.imports ?? []),
        DiscoveryModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
          useFactory: (opts: ZuckerAuthModuleOptions) => ({
            secret: resolveJwtSecret(opts),
            signOptions: { expiresIn: '7d' },
          }),
          inject: [AUTH_MODULE_OPTIONS],
        }),
      ],
      controllers: MODULE_CONTROLLERS,
      providers: [
        ...asyncProviders,
        ...this.buildProviders(AUTH_MODULE_OPTIONS),
        // For async path, TOKEN_CACHE defaults to null; consumers can override
        { provide: TOKEN_CACHE, useValue: null },
      ],
      exports: MODULE_EXPORTS,
    };
  }

  private static createAsyncProviders(options: ZuckerAuthModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: AUTH_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: AUTH_MODULE_OPTIONS,
      useFactory: async (factory: ZuckerAuthModuleOptionsFactory) => factory.createAuthOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
