#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import Backup from './commands/backup.js';
import Restore from './commands/restore.js';
import { initMessage } from './utils/misc.js';

const backup = Backup.yargsCommand();
const restore = Restore.yargsCommand();

console.log(initMessage);

try {
    await yargs(hideBin(process.argv))
        .command(backup)
        .command(restore)
        .help()
        .alias('h', 'help')
        .alias('v', 'version')
        // errors thrown by commands are theirs to report, not usage mistakes.
        .fail((message, error, cli) => {
            if (error) throw error;
            cli.showHelp();
            console.error(`\n${message}`);
            process.exit(1);
        })
        .parseAsync();
} catch (error) {
    // Ctrl+C at a prompt, before any cleanup is needed.
    if (error?.name !== 'ExitPromptError') throw error;
    process.exitCode = 130;
}
