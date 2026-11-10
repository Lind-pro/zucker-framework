/**
 * Authorization controller
 *
 * Endpoints:
 * - GET  /authorize/me    — current user's authentication info
 * - POST /authorize/login — username/password login
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Public, Permissions } from '../decorators';
import { TokenService } from '../services/token.service';
import { AuthenticationHolder } from '../authentication';
import type { Authentication, AuthUser } from '../interfaces';
import { TokenState, AllopatricLoginMode } from '../interfaces';
import {
  AUTH_EVENT_TOPICS,
  createLoginBeforeEvent,
  createLoginDecodeEvent,
  createLoginSuccessEvent,
  createLoginFailedEvent,
} from '../events';
import { UnauthorizedException, ValidationException } from '@zucker-framework/core';
import { randomUUID } from 'node:crypto';

interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

const SECRET_FIELDS = new Set(['password', 'newPassword', 'oldPassword', 'confirmPassword', 'decodedPassword']);

function withoutSecrets<T extends Record<string, unknown>>(body: T): T {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !SECRET_FIELDS.has(key))) as T;
}

export interface LoginRequest {
  username: string;
  password: string;
  [key: string]: unknown;
}

export interface LoginResult {
  userId: string;
  token: string;
  expires: number;
  [key: string]: unknown;
}

export interface AuthenticationManagerLike {
  authenticate(username: string, password: string): Promise<AuthUser | null>;
  getByUserId?(userId: string): Promise<Authentication | null>;
}

export const AUTHENTICATION_MANAGER = 'AUTHENTICATION_MANAGER';

@Controller('authorize')
export class AuthorizationController {
  private readonly logger = new Logger(AuthorizationController.name);

  constructor(
    private readonly tokenService: TokenService,
    @Inject(AUTHENTICATION_MANAGER)
    private readonly authManager: AuthenticationManagerLike,
    @Optional()
    private readonly authHolder?: AuthenticationHolder,
    @Optional()
    @Inject(TOPIC_EVENT_BUS)
    private readonly eventBus?: TopicEventBusLike,
  ) {}

  /**
   * GET /authorize/me — current user's authentication info.
   */
  @Get('me')
  @Permissions()
  async me(@Req() req: { user?: AuthUser; auth?: Authentication }): Promise<Authentication> {
    if (req.auth) return req.auth;
    if (this.authHolder) {
      const auth = this.authHolder.getCurrent();
      if (auth) return auth;
    }
    throw new UnauthorizedException('not_logged_in');
  }

  /**
   * POST /authorize/login — username/password login.
   * 1. DecodeEvent (可修改密码/用户名)
   * 2. BeforeEvent (可阻止登录/注入已认证用户)
   * 3. authenticate
   * 4. SuccessEvent / FailedEvent
   */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SetMetadata('ZUCKER_RATE_LIMIT', { limiter: 'login', keyExtractor: '#ip', message: '登录尝试过于频繁，请稍后再试' })
  async login(@Body() body: LoginRequest): Promise<LoginResult> {
    let { username, password } = body;
    // Only the in-process decode step may see the credential; every other event (which may be
    // queued or logged by a distributed bus) gets the body without secrets.
    const safeBody = withoutSecrets(body);

    if (!username?.trim()) {
      throw new ValidationException(
        { username: ['username must not be empty'] },
        'validation.username_must_not_be_empty',
      );
    }
    if (!password) {
      throw new ValidationException(
        { password: ['password must not be empty'] },
        'validation.password_must_not_be_empty',
      );
    }

    try {
      // 1. DecodeEvent — allow listeners to decode/transform credentials
      if (this.eventBus) {
        const decodeEvent = createLoginDecodeEvent(username, password, body);
        await this.eventBus.publish(AUTH_EVENT_TOPICS.LOGIN_DECODE, decodeEvent);
        if (decodeEvent.decodedPassword) {
          password = decodeEvent.decodedPassword;
        }
      }

      // 2. BeforeEvent — allow listeners to pre-authorize or block
      let preAuthorizedUserId: string | undefined;
      if (this.eventBus) {
        const beforeEvent = createLoginBeforeEvent(username, safeBody);
        await this.eventBus.publish(AUTH_EVENT_TOPICS.LOGIN_BEFORE, beforeEvent);
        if (beforeEvent.isAuthorized && beforeEvent.authorizedUserId) {
          preAuthorizedUserId = beforeEvent.authorizedUserId;
        }
      }

      // 3. Authenticate
      let user: AuthUser | null;
      if (preAuthorizedUserId) {
        // Pre-authorized by BeforeEvent listener
        const auth = this.authManager.getByUserId
          ? await this.authManager.getByUserId(preAuthorizedUserId)
          : null;
        user = auth?.getUser() ?? null;
        if (!user) {
          throw new UnauthorizedException('user_disabled');
        }
      } else {
        user = await this.authManager.authenticate(username, password);
        if (!user) {
          throw new UnauthorizedException('illegal_password');
        }
      }

      // 4. Sign in and create token
      const jwtService = this.tokenService['jwtService'];
      if (!jwtService) throw new Error('JwtService is required to issue access tokens');
      // typ/jti: bind the token to the access-token audience and make each login revocable
      // on its own even when two logins happen within the same second.
      const jwt = jwtService.sign({ sub: user.id, username: user.username, typ: 'access', jti: randomUUID() });
      const tokenInfo = await this.tokenService.signIn(
        user.id,
        jwt,
        'default',
        7200000,
      );

      const result: LoginResult = {
        userId: user.id,
        token: tokenInfo.token,
        expires: tokenInfo.maxInactiveInterval ?? 7200000,
      };

      // 5. SuccessEvent
      if (this.eventBus) {
        const successEvent = createLoginSuccessEvent(user.id, username, result, safeBody);
        await this.eventBus.publish(AUTH_EVENT_TOPICS.LOGIN_SUCCESS, successEvent);
      }

      return result;
    } catch (error) {
      // FailedEvent
      if (this.eventBus) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const failedEvent = createLoginFailedEvent(
          username,
          errorMsg,
          error instanceof Error ? error : undefined,
          safeBody,
        );
        await this.eventBus.publish(AUTH_EVENT_TOPICS.LOGIN_FAILED, failedEvent);
      }
      throw error;
    }
  }
}
