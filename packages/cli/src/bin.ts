#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { createCommand } from './commands/create.js';
import { addCommand } from './commands/add.js';
import { extCommand } from './commands/ext.js';
import { createAICommand } from './commands/ai.js';

const program = new Command();

program
  .name('zucker')
  .description('CLI tool for Zucker Framework')
  .version((JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string }).version);

program.addCommand(createCommand);
program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(addCommand);
program.addCommand(extCommand);
program.addCommand(createAICommand());

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误：${message}\n`);
  process.exitCode = 1;
});
