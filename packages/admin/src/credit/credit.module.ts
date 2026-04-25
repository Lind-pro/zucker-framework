import { Module } from '@nestjs/common';
import { CreditController } from './credit.controller';

/**
 * ZuckerCreditAdminModule
 *
 * CreditService is provided globally by ZuckerCreditModule.forRoot().
 */
@Module({
  controllers: [CreditController],
})
export class ZuckerCreditAdminModule {}
