import { Module } from '@nestjs/common';
import { FormController } from './form.controller';

/**
 * ZuckerFormAdminModule — admin REST layer for the form engine.
 *
 * FormService is provided globally by ZuckerFormModule.forRoot() which must be
 * imported in the host AppModule before ZuckerAdminModule.
 */
@Module({
  controllers: [FormController],
})
export class ZuckerFormAdminModule {}
