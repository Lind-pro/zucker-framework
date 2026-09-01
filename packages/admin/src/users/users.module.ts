import { Module } from '@nestjs/common';
import { ZuckerAuthModule } from '@zucker/auth';
import { UsersController } from './users.controller';

@Module({
  imports: [ZuckerAuthModule],
  controllers: [UsersController],
})
export class ZuckerUsersAdminModule {}
