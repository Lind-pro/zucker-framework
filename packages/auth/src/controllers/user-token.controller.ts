/**
 * User token management controller — mirrors hsweb ReactiveUserTokenController.
 *
 * Provides REST endpoints for token lifecycle management:
 * - Query tokens by user/token
 * - Kick users offline
 * - Change token state
 * - Check expired tokens
 * - Touch (refresh) token TTL
 */
import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TokenService } from '../services/token.service';
import { Resource, QueryAction, SaveAction } from '../decorators';
import type { TokenInfo } from '../interfaces';
import { TokenState } from '../interfaces';

@Controller('user-token')
@Resource({ id: 'user-token', name: '用户令牌信息管理' })
export class UserTokenController {
  constructor(private readonly tokenService: TokenService) {}

  /**
   * GET /user-token/reset — reset current user's token (sign out self).
   */
  @Get('reset')
  async resetToken(): Promise<boolean> {
    // In a real implementation, extract token from request context
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

  /**
   * GET /user-token/token/:token — get token info by token string.
   */
  @Get('token/:token')
  @QueryAction()
  async getByToken(@Param('token') token: string): Promise<TokenInfo | null> {
    return this.tokenService.getByToken(token);
  }

  /**
   * GET /user-token/user/:userId — get all tokens for a user.
   */
  @Get('user/:userId')
  @QueryAction()
  async getByUserId(@Param('userId') userId: string): Promise<TokenInfo[]> {
    return this.tokenService.getByUserId(userId);
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
   * GET /user-token/token/:token/logged — check if token is active.
   */
  @Get('token/:token/logged')
  @QueryAction()
  async tokenIsLoggedIn(@Param('token') token: string): Promise<boolean> {
    return this.tokenService.tokenIsLoggedIn(token);
  }

  /**
   * GET /user-token/user/total — total logged-in users.
   */
  @Get('user/total')
  async totalUser(): Promise<number> {
    return this.tokenService.totalUsers();
  }

  /**
   * GET /user-token/token/total — total active tokens.
   */
  @Get('token/total')
  async totalToken(): Promise<number> {
    return this.tokenService.totalTokens();
  }

  /**
   * GET /user-token — list all active tokens.
   */
  @Get()
  @QueryAction()
  async allLoggedUser(): Promise<TokenInfo[]> {
    return this.tokenService.allLoggedTokens();
  }

  /**
   * DELETE /user-token/user/:userId — kick user offline by userId.
   */
  @Delete('user/:userId')
  @SaveAction()
  async signOutByUserId(@Param('userId') userId: string): Promise<void> {
    await this.tokenService.signOutByUserId(userId);
  }

  /**
   * DELETE /user-token/token/:token — invalidate a specific token.
   */
  @Delete('token/:token')
  @SaveAction()
  async signOutByToken(@Param('token') token: string): Promise<void> {
    await this.tokenService.signOut(token);
  }

  /**
   * PUT /user-token/user/:userId/:state — change all tokens for a user to a state.
   */
  @Put('user/:userId/:state')
  @SaveAction()
  @HttpCode(HttpStatus.OK)
  async changeUserState(
    @Param('userId') userId: string,
    @Param('state') state: string,
  ): Promise<void> {
    const tokenState = TokenState[state as keyof typeof TokenState];
    if (!tokenState) {
      throw new Error(`Invalid token state: ${state}`);
    }
    await this.tokenService.changeUserState(userId, tokenState);
  }

  /**
   * GET /user-token/:token/touch — refresh token TTL.
   */
  @Get(':token/touch')
  @SaveAction()
  async touch(@Param('token') token: string): Promise<void> {
    await this.tokenService.touch(token);
  }
}
