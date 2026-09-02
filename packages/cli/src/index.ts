#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { addCommand } from './commands/add.js';
import { extCommand } from './commands/ext.js';
import { createAICommand } from './commands/ai.js';

const program = new Command();

program
  .name('zucker')
  .description('CLI tool for Zucker Framework')
  .version('0.1.0-rc.0');

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
