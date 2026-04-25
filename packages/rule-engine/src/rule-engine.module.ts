import { Module } from '@nestjs/common';
import { RuleEngineService } from './rule-engine.service';
import { TaskExecutorRegistry } from './core/task-executor-registry';

@Module({
  providers: [RuleEngineService, TaskExecutorRegistry],
  exports: [RuleEngineService, TaskExecutorRegistry],
})
export class ZuckerRuleEngineModule {}
