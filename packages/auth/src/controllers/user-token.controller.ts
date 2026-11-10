/**
 * User token management controller
 *
 * Provides REST endpoints for token lifecycle management:
 * - Query tokens by user/token id
 * - Kick users offline
 * - Change token state
 * - Check expired tokens
 * - Touch (refresh) token TTL
 *
 * Raw bearer tokens are never returned and never accepted in a URL: sessions are
 * addressed by `tokenId`, a SHA-256 digest of the token (see {@link tokenIdOf}).
 */
import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ValidationException } from '@zucker-framework/core';
import { TokenService } from '../services/token.service';
import { Resource, QueryAction, SaveAction, Permissions } from '../decorators';
import type { TokenInfo } from '../interfaces';
import { TokenState } from '../interfaces';
import { bearerToken } from '../guards/access-token-claims';

/** Public, non-credential view of a session. */
export type TokenInfoView = Omit<TokenInfo, 'token'> & { tokenId: string };

/** Stable identifier of a token that cannot be used as a credential. */
export function tokenIdOf(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function toView(info: TokenInfo): TokenInfoView {
  const { token, ...rest } = info;
  return { ...rest, tokenId: tokenIdOf(token) };
}

function parseState(state: string): TokenState {
  const values = Object.values(TokenState) as string[];
  const normalized = state.toLowerCase();
  if (values.includes(normalized)) return normalized as TokenState;
  throw new ValidationException({ state: [`must be one of ${values.join(', ')}`] }, 'Invalid token state');
}

@Controller('user-token')
@Resource({ id: 'user-token', name: '用户令牌信息管理' })
export class UserTokenController {
  constructor(private readonly tokenService: TokenService) {}

  private async findToken(tokenId: string): Promise<TokenInfo | undefined> {
    const all = await this.tokenService.allLoggedTokens();
    return all.find((info) => tokenIdOf(info.token) === tokenId);
  }

  /**
   * GET /user-token/reset — sign out the caller's own token.
   */
  @Get('reset')
  @Permissions()
  async resetToken(@Req() req: { headers?: { authorization?: string } }): Promise<boolean> {
    const token = bearerToken(req.headers?.authorization);
    if (!token) return false;
    await this.tokenService.signOut(token);
    return true;
  }

  /**
   * PUT /user-token/check — check and remove all expired tokens.
   */
  @Put('check')
  @SaveAction()
  @HttpCode(HttpStatus.OK)
  async checkExpiredToken(): Promise<boolean> {
    await this.tokenService.checkExpired();
    return true;
  }

  // Static routes are declared before their parameterised siblings so they are not shadowed.

  /**
   * GET /user-token/user/total — total logged-in users.
   */
  @Get('user/total')
  @QueryAction()
  async totalUser(): Promise<number> {
    return this.tokenService.totalUsers();
  }

  /**
   * GET /user-token/token/total — total active tokens.
   */
  @Get('token/total')
  @QueryAction()
  async totalToken(): Promise<number> {
    return this.tokenService.totalTokens();
  }

  /**
   * GET /user-token/token/:tokenId — get token info by token id.
   */
  @Get('token/:tokenId')
  @QueryAction()
  async getByToken(@Param('tokenId') tokenId: string): Promise<TokenInfoView | null> {
    const info = await this.findToken(tokenId);
    if (!info) return null;
    const current = await this.tokenService.getByToken(info.token);
    return current ? toView(current) : null;
  }

  /**
   * GET /user-token/user/:userId — get all tokens for a user.
   */
  @Get('user/:userId')
  @QueryAction()
  async getByUserId(@Param('userId') userId: string): Promise<TokenInfoView[]> {
    return (await this.tokenService.getByUserId(userId)).map(toView);
  }

  /**
   * GET /user-token/user/:userId/logged — check if user is logged in.
   */
  @Get('user/:userId/logged')
  @QueryAction()
  async userIsLoggedIn(@Param('userId') userId: string): Promise<boolean> {
    return this.tokenService.userIsLoggedIn(userId);
  }

  /**
   * GET /user-token/token/:tokenId/logged — check if token is active.
   */
  @Get('token/:tokenId/logged')
  @QueryAction()
  async tokenIsLoggedIn(@Param('tokenId') tokenId: string): Promise<boolean> {
    const info = await this.findToken(tokenId);
    return info ? this.tokenService.tokenIsLoggedIn(info.token) : false;
  }

  /**
   * GET /user-token — list all active sessions.
   */
  @Get()
  @QueryAction()
  async allLoggedUser(): Promise<TokenInfoView[]> {
    return (await this.tokenService.allLoggedTokens()).map(toView);
  }

  /**
   * DELETE /user-token/user/:userId — kick user offline by userId (all instances sharing the cache).
   */
  @Delete('user/:userId')
  @SaveAction()
  async signOutByUserId(@Param('userId') userId: string): Promise<void> {
    await this.tokenService.signOutByUserId(userId);
  }

  /**
   * DELETE /user-token/token/:tokenId — invalidate a specific token.
   */
  @Delete('token/:tokenId')
  @SaveAction()
  async signOutByToken(@Param('tokenId') tokenId: string): Promise<void> {
    const info = await this.findToken(tokenId);
    if (info) await this.tokenService.signOut(info.token);
  }

  /**
   * PUT /user-token/user/:userId/:state — change all tokens for a user to a state
   * (`normal`, `lock`, `offline`, ...; enum keys such as `LOCK` are also accepted).
   */
  @Put('user/:userId/:state')
  @SaveAction()
  @HttpCode(HttpStatus.OK)
  async changeUserState(
    @Param('userId') userId: string,
    @Param('state') state: string,
  ): Promise<void> {
    await this.tokenService.changeUserState(userId, parseState(state));
  }

  /**
   * GET /user-token/:tokenId/touch — refresh token TTL.
   */
  @Get(':tokenId/touch')
  @SaveAction()
  async touch(@Param('tokenId') tokenId: string): Promise<void> {
    const info = await this.findToken(tokenId);
    if (info) await this.tokenService.touch(info.token);
  }
}
