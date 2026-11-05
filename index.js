#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import Backup from './commands/backup.js';
import Restore from './commands/restore.js';
import Share from './commands/share.js';
import { initMessage, signalExitCode } from './utils/misc.js';

const backup = Backup.yargsCommand();
const restore = Restore.yargsCommand();
const share = Share.yargsCommand();

console.log(initMessage);

yargs(hideBin(process.argv))
    .command(backup)
    .command(restore)
    .command(share)
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
    .parseAsync()
    .catch((error) => {
        // a prompt closed by Ctrl+C, or by the end of a non-interactive stdin.
        if (error?.name !== 'ExitPromptError') throw error;
        process.exitCode ||= process.stdin.isTTY ? signalExitCode('SIGINT') : 1;
    });
