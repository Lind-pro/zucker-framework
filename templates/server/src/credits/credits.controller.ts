import { Controller, Get, HttpException, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { CreditHoldMigrationRequiredError, CreditLotHoldError } from '@zucker-framework/credit';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { CreditsService, creditPageOptions } from './credits.service';

@Controller('credits')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}
  private async result<T>(work: () => Promise<T>) {
    try { return await work(); } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof CreditHoldMigrationRequiredError || error instanceof CreditLotHoldError)
        throw new ServiceUnavailableException('Credit records require reconciliation before use');
      throw new ServiceUnavailableException('Credit records are unavailable');
    }
  }
  @Get('balance')
  balance(@Req() request: { user: { id: string } }) { return this.result(() => this.credits.balance(request.user.id)); }
  @Get('transactions')
  transactions(@Req() request: { user: { id: string } }, @Query() query: Record<string, unknown>) {
    return this.result(() => this.credits.transactions(request.user.id, creditPageOptions(query, true)));
  }
  @Get('lots')
  lots(@Req() request: { user: { id: string } }, @Query() query: Record<string, unknown>) {
    return this.result(() => this.credits.lots(request.user.id, creditPageOptions(query, false)));
  }
}
