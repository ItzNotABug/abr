#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import Backup from './commands/backup.js';
import Restore from './commands/restore.js';
import { initMessage } from './utils/misc.js';

const backup = Backup.yargsCommand();
const restore = Restore.yargsCommand();

console.log(initMessage);

yargs(hideBin(process.argv))
    .command(backup)
    .command(restore)
    .help()
    .alias('h', 'help')
    .alias('v', 'version').argv;
