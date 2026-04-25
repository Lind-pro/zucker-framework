import { Module, Global } from '@nestjs/common';
import { RedisClusterManager } from './cluster-manager';
import { RedisDistributedLock } from './distributed-lock';

@Global()
@Module({
  providers: [RedisClusterManager, RedisDistributedLock],
  exports: [RedisClusterManager, RedisDistributedLock],
})
export class ZuckerClusterModule {}
