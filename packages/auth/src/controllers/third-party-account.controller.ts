import {
  Controller,
  Inject,
  Post,
  Delete,
  Get,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import {
  ThirdPartyAccountService,
  type ThirdPartyBindingRequest,
} from '../services/third-party-account.service';
import { Permissions } from '../decorators';

@Controller('third-party-account')
export class ThirdPartyAccountController {
  constructor(
    @Inject(ThirdPartyAccountService) private readonly thirdPartyAccountService: ThirdPartyAccountService,
  ) {}

  /** 获取当前用户的所有第三方绑定 */
  @Get()
  @Permissions()
  async getBinds(@Req() req: { user: { id: string } }) {
    return this.thirdPartyAccountService.getUserBinds(req.user.id);
  }

  /** 绑定第三方账号 */
  @Post('bind/:provider')
  @Permissions()
  async bind(
    @Req() req: ThirdPartyBindingRequest,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ) {
    const proof = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { proof?: unknown }).proof : undefined;
    await this.thirdPartyAccountService.bindAccountWithProof(req.user.id, provider, proof, req);
    return { success: true };
  }

  /** 解绑第三方账号 */
  @Delete('unbind/:provider')
  @Permissions()
  async unbind(
    @Req() req: { user: { id: string } },
    @Param('provider') provider: string,
  ) {
    await this.thirdPartyAccountService.unbindAccount(
      req.user.id,
      provider,
    );
    return { success: true };
  }
}
