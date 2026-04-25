import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { addCommand } from './commands/add.js';

const program = new Command();

program
  .name('zucker')
  .description('CLI tool for Zucker Framework')
  .version('0.0.1');

program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(addCommand);

program.parse();
