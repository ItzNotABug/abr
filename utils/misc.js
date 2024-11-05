import chalk from 'chalk';
import { execa } from 'execa';
import * as path from 'path';

// Pink - The Brand Color
const asciiArt = chalk.hex('#FD366E').bold(`
    _ _     _   ___ ___           _                        _ _         ___          _               ___        _               
  _| | |_  /_\\ | _ ) _ \\  ___    /_\\  _ __ _ ____ __ ___ _(_) |_ ___  | _ ) __ _ __| |___  _ _ __  | _ \\___ __| |_ ___ _ _ ___ 
 |_  .  _|/ _ \\| _ \\   / |___|  / _ \\| '_ \\ '_ \\ V  V / '_| |  _/ -_) | _ \\/ _\` / _| / / || | '_ \\ |   / -_|_-<  _/ _ \\ '_/ -_)
 |_     _/_/ \\_\\___/_|_\\       /_/ \\_\\ .__/ .__/\\_/\\_/|_| |_|\\__\\___| |___/\\__,_\\__|_\\_\\\\_,_| .__/ |_|_\\___/__/\\__\\___/_| \\___|
   |_|_|                             |_|  |_|                                               |_|                                

`);

/**
 * CLI init message.
 */
export const initMessage = `${asciiArt}
${chalk.blue.bold('#ABR - Appwrite Backup Restore')}
${chalk.yellow('A powerful CLI tool for managing complete backups and seamless restorations of your Appwrite instance, ensuring data consistency & quick recovery.')}
${chalk.blue('_'.repeat(146))}
`;

/**
 * Appwrite docker volumes.
 */
export const appwriteVolumes = [
    'appwrite_appwrite-redis',
    'appwrite_appwrite-cache',
    'appwrite_appwrite-builds',
    'appwrite_appwrite-config',
    'appwrite_appwrite-executor',
    'appwrite_appwrite-mariadb',
    'appwrite_appwrite-uploads',
    'appwrite_appwrite-functions',
    'appwrite_appwrite-certificates',
];

/**
 * Backup types.
 */
export const backupTypes = [
    {
        value: 'hot-backup',
        name: `${chalk.bold('Hot Backup')} - Fast, Zero Downtime ${chalk.red.bold('(Experimental – Keeps Appwrite running; potential data inconsistency)')}`,
    },
    {
        value: 'semi-cold-backup',
        name: `${chalk.bold('Semi-Cold Backup')} - Minimal Downtime, Ensured Consistency ${chalk.yellow.bold('(Pauses Appwrite briefly for data safety)')}`,
    },
    {
        value: 'cold-backup',
        name: `${chalk.bold('Cold Backup')} - Slow, Full Consistency ${chalk.green.bold('(Brief downtime; stops Appwrite for guaranteed data consistency)')}`,
    },
];

/**
 * Checks if `Docker` is installed and running.
 */
export async function checkDocker(loader) {
    loader.start('Checking if available Docker...');

    try {
        await execa('docker', ['info']);
        loader.stop();

        console.log(chalk.green('✅ Docker is running.'));
        return true;
    } catch (error) {
        loader.stop();

        if (error.code === 'ENOENT') {
            console.log(
                chalk.red('❌ Error: Docker is not installed on your system.'),
            );
        } else {
            console.log(
                chalk.red(
                    '❌ Error: Docker is not running. Please start Docker and try again.',
                ),
            );
        }
        return false;
    }
}

/**
 * Restarts the appwrite stack. Note that this will take a while because this also fetches all the pruned images from docker hub.
 */
export async function restartAppwriteStack(loader) {
    loader.start(chalk.blue('Restarting appwrite (This can take a while...)'));
    try {
        await execa('docker', ['compose', 'up', '-d'], {
            cwd: path.join(process.cwd(), 'appwrite'),
        });

        loader.stop();
        console.log(chalk.green('✅ Appwrite stack restarted.'));
    } catch (error) {
        loader.stop();
        console.error(
            chalk.red('❌ Error during Appwrite restart:'),
            error.message,
        );
    }
}

/**
 * Resumes the appwrite stack.
 */
export async function resumeAppwriteStack(loader) {
    loader.start(chalk.blue('Resuming appwrite'));
    try {
        await execa('docker', ['compose', 'unpause'], {
            cwd: path.join(process.cwd(), 'appwrite'),
        });

        loader.stop();
        console.log(chalk.green('✅ Appwrite stack resumed.'));
    } catch (error) {
        loader.stop();
        console.error(
            chalk.red('❌ Error during Appwrite resumption:'),
            error.message,
        );
    }
}
