import {
  Global,
  Logger,
  Module,
  type DynamicModule,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { DiscoveryModule, ModuleRef, Reflector } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService, type JwtModuleOptions, type JwtSignOptions } from '@nestjs/jwt';
import type { DatabaseAdapter } from '@zucker-framework/core';
import type { ICache } from '@zucker-framework/cache';
import {
  DIMENSION_PROVIDERS,
  type DimensionProvider,
  type ZuckerAuthModuleOptions,
} from './interfaces';
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
import {
  AuthorizationController,
  AUTHENTICATION_MANAGER,
} from './controllers/authorization.controller';
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
  /**
   * Register the framework's generic HTTP controllers.
   * Defaults to true for backwards compatibility.
   */
  registerControllers?: boolean;
  /**
   * Injection token of the shared ICache used for token revocation and session activity.
   * Registered as `{ provide: TOKEN_CACHE, useExisting: cacheProvider }`, so Nest instantiates
   * it before TokenService regardless of module import order. Takes precedence over an
   * options-level `cacheProvider` returned by `useFactory`.
   */
  cacheProvider?: string | symbol;
  useFactory?: (...args: unknown[]) => ZuckerAuthModuleOptions | Promise<ZuckerAuthModuleOptions>;
  useClass?: Type<ZuckerAuthModuleOptionsFactory>;
  useExisting?: Type<ZuckerAuthModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface ZuckerAuthModuleOptionsFactory {
  createAuthOptions(): ZuckerAuthModuleOptions | Promise<ZuckerAuthModuleOptions>;
}

const AUTH_MODULE_OPTIONS = Symbol('AUTH_MODULE_OPTIONS');

/** Internal holder of the async auth options (see `ZuckerAuthModule.forRootAsync`). */
@Module({})
class ZuckerAuthOptionsModule {}

/**
 * Resolve the JWT secret from options, enforcing explicit configuration
 * in non-development environments.
 */
/** Environments in which the public development secret may be used. */
const INSECURE_SECRET_ENVIRONMENTS = new Set(['development', 'test']);
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Resolve the JWT secret from options (or the JWT_SECRET environment variable).
 * The public development fallback is only allowed when NODE_ENV is explicitly
 * `development` or `test`; every other environment (including an unset NODE_ENV)
 * must configure a secret of at least 32 characters.
 */
export function resolveJwtSecret(options: ZuckerAuthModuleOptions): string {
  const nodeEnv = process.env.NODE_ENV;
  const relaxed = nodeEnv !== undefined && INSECURE_SECRET_ENVIRONMENTS.has(nodeEnv);
  const secret = options.jwtSecret || process.env.JWT_SECRET;
  const logger = new Logger('ZuckerAuthModule');

  if (secret) {
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
      if (!relaxed) {
        throw new Error(
          `[ZuckerAuthModule] jwtSecret must be at least ${MIN_JWT_SECRET_LENGTH} characters outside development/test.`,
        );
      }
      logger.warn(`jwtSecret is shorter than ${MIN_JWT_SECRET_LENGTH} characters.`);
    }
    return secret;
  }

  if (!relaxed) {
    throw new Error(
      '[ZuckerAuthModule] jwtSecret is required unless NODE_ENV is development or test. ' +
        'Set it via ZuckerAuthModule.forRoot({ jwtSecret }) or the JWT_SECRET environment variable.',
    );
  }

  // Development fallback — logged as warning so it's never silent
  logger.warn('Using insecure default JWT secret. Set jwtSecret for production use.');
  return '__zucker_dev_only_secret__';
}

const DEFAULT_ACCESS_TOKEN_TTL = '7d';

function jwtModuleOptions(opts: ZuckerAuthModuleOptions): JwtModuleOptions {
  return {
    secret: resolveJwtSecret(opts),
    signOptions: {
      expiresIn: (opts.accessTokenTtl ?? DEFAULT_ACCESS_TOKEN_TTL) as JwtSignOptions['expiresIn'],
      algorithm: 'HS256',
    },
    verifyOptions: { algorithms: ['HS256'] },
  };
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
        useFactory: (opts: ZuckerAuthModuleOptions) => new JwtStrategy(resolveJwtSecret(opts)),
        inject: [optionsToken],
      },

      // --- Services that need DatabaseAdapter ---
      {
        provide: RoleHierarchyService,
        useFactory: (db: DatabaseAdapter, opts: ZuckerAuthModuleOptions) =>
          new RoleHierarchyService(db, opts.roleHierarchyCacheTtlMs),
        inject: [DATABASE_ADAPTER, optionsToken],
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
        useFactory: (db: DatabaseAdapter, opts: ZuckerAuthModuleOptions) => new ThirdPartyAccountService(db, opts.thirdPartyAccounts),
        inject: [DATABASE_ADAPTER, optionsToken],
      },

      // --- TokenService with optional cache ---
      {
        provide: TokenService,
        useFactory: (opts: ZuckerAuthModuleOptions, cache: ICache | null, jwtSvc: JwtService, moduleRef: ModuleRef) => {
          const svc = new TokenService(cache || undefined, jwtSvc);
          svc.configure({
            ...(opts.maxActiveSessions ? { maxActiveSessions: opts.maxActiveSessions } : {}),
            ...(opts.allopatricLoginMode !== undefined ? { allopatricLoginMode: opts.allopatricLoginMode } : {}),
            ...(opts.tokenBlacklistTtlMs !== undefined ? { blacklistTtlMs: opts.tokenBlacklistTtlMs } : {}),
            ...(opts.enforceSessionInactivity !== undefined ? { enforceSessionInactivity: opts.enforceSessionInactivity } : {}),
          });
          if (!cache && opts.cacheProvider) {
            // forRootAsync with an options-level cacheProvider: the token could not be injected
            // statically. Resolve it once every singleton exists (onApplicationBootstrap); a
            // ModuleRef.get at factory time is order-dependent and may return an unbuilt instance.
            const cacheToken = opts.cacheProvider;
            svc.setCacheResolver(() => {
              try {
                return moduleRef.get<ICache>(cacheToken, { strict: false });
              } catch {
                return undefined;
              }
            });
          }
          return svc;
        },
        inject: [optionsToken, TOKEN_CACHE, JwtService, ModuleRef],
      },

      // --- User / Role / Authorization ---
      {
        provide: UserService,
        // Disabling, deleting or re-passwording a user revokes that user's tokens.
        useFactory: (db: DatabaseAdapter, tokens: TokenService) => new UserService(db, undefined, undefined, tokens),
        inject: [DATABASE_ADAPTER, TokenService],
      },
      {
        provide: RoleService,
        // Wired so role changes invalidate the hierarchy and permission caches.
        useFactory: (db: DatabaseAdapter, permissions: PermissionService, hierarchy: RoleHierarchyService) => {
          const svc = new RoleService(db, undefined, permissions);
          svc.setRoleHierarchyService(hierarchy);
          return svc;
        },
        inject: [DATABASE_ADAPTER, PermissionService, RoleHierarchyService],
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
      Reflector,
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
          // Compared against when the user is missing so response time does not reveal
          // whether a username exists.
          let dummyHash: Promise<string> | undefined;
          return {
            async authenticate(username: string, password: string) {
              const user = await userService.findByUsername(username);
              if (!user || !user.password) {
                dummyHash ??= encoder.encode('__zucker_dummy_password__');
                await encoder.matches(password, await dummyHash);
                return null;
              }
              const ok = await encoder.matches(password, user.password);
              // Disabled accounts cannot obtain new tokens.
              if (!ok || !user.status) return null;
              const { password: _password, ...safeUser } = user;
              return safeUser as typeof user;
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
  private static buildOptionSpecificProviders(options: ZuckerAuthModuleOptions): Provider[] {
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
    const jwtOptions = jwtModuleOptions(options);

    // Sync options: provide a literal-value token so buildProviders can inject it
    const optionsProvider: Provider = {
      provide: AUTH_MODULE_OPTIONS,
      useValue: options,
    };

    return {
      module: ZuckerAuthModule,
      global: true,
      imports: [
        DiscoveryModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register(jwtOptions),
      ],
      controllers: options.registerControllers === false ? [] : MODULE_CONTROLLERS,
      providers: [
        optionsProvider,
        ...this.buildProviders(AUTH_MODULE_OPTIONS),
        ...this.buildOptionSpecificProviders(options),
      ],
      exports: MODULE_EXPORTS,
    };
  }

  static forRootAsync(asyncOptions: ZuckerAuthModuleAsyncOptions): DynamicModule {
    // The options live in their own module, imported both here and by JwtModule.registerAsync:
    // a provider declared on ZuckerAuthModule is not visible inside JwtModule's scope. The same
    // DynamicModule object is imported twice, so Nest builds the options factory once.
    const optionsModule: DynamicModule = {
      module: ZuckerAuthOptionsModule,
      imports: [...(asyncOptions.imports ?? [])],
      providers: this.createAsyncProviders(asyncOptions),
      exports: [AUTH_MODULE_OPTIONS],
    };

    return {
      module: ZuckerAuthModule,
      global: true,
      imports: [
        ...(asyncOptions.imports ?? []),
        optionsModule,
        DiscoveryModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
          imports: [optionsModule],
          useFactory: (opts: ZuckerAuthModuleOptions) => jwtModuleOptions(opts),
          inject: [AUTH_MODULE_OPTIONS],
        }),
      ],
      controllers: asyncOptions.registerControllers === false ? [] : MODULE_CONTROLLERS,
      providers: [
        ...this.buildProviders(AUTH_MODULE_OPTIONS),
        // A top-level cacheProvider is injected statically (instantiated before TokenService).
        // Otherwise TokenService resolves an options-level cacheProvider at bootstrap.
        asyncOptions.cacheProvider
          ? { provide: TOKEN_CACHE, useExisting: asyncOptions.cacheProvider }
          : { provide: TOKEN_CACHE, useValue: null },
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
