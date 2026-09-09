import { Module } from '@nestjs/common';
import { ZuckerAuthModule } from '@zucker-framework/auth';
import { UsersController } from './users.controller';

@Module({
  imports: [ZuckerAuthModule],
  controllers: [UsersController],
})
export class ZuckerUsersAdminModule {}
