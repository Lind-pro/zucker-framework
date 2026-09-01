import { Module, Global } from '@nestjs/common';
import { JavaScriptScriptFactory } from './script-factory';
import { ExposedScriptRegistry } from './exposed-script';

@Global()
@Module({
  providers: [JavaScriptScriptFactory, ExposedScriptRegistry],
  exports: [JavaScriptScriptFactory, ExposedScriptRegistry],
})
export class ZuckerScriptModule {}
