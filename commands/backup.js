import * as fs from 'fs';
import chalk from 'chalk';
import { execa } from 'execa';
import * as path from 'path';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteVolumes,
    backupTypes,
    checkDocker,
    restartAppwriteStack,
    resumeAppwriteStack,
} from '../utils/misc.js';

const loader = loading('');

export default class Backup {
    static #backupType;

    /**
     * The backup command for `yargs` to manage.
     */
    static yargsCommand() {
        return {
            command: 'backup',
            description:
                'Backups your Appwrite instance with all volumes and SQL data!',
            builder: (_) => null,
            handler: async (_) => await this.#performTask(),
        };
    }

    /**
     * Starts task once yargs receives the command.
     */
    static async #performTask() {
        this.#backupType = '';

        if (!(await checkDocker(loader))) return;
        if (!this.#checkForAppwriteFolder()) return;
        await this.#checkVolumeSizes();
        await this.#performBackup();

        if (this.#backupType === 'cold-backup') {
            await restartAppwriteStack(loader);
        } else if (this.#backupType === 'semi-hot-backup') {
            await resumeAppwriteStack(loader);
        }

        this.#backupType = '';
    }

    /**
     * Prints the volume sizes.
     */
    static async #checkVolumeSizes() {
        loader.start('Checking volume sizes...');

        try {
            const { stdout } = await execa('docker', [
                'system',
                'df',
                '-v',
                '--format',
                '{{ json .Volumes }}',
            ]);

            const volumesData = JSON.parse(stdout);

            const volumeSizes = appwriteVolumes.map((volumeName) => {
                const volumeData = volumesData.find((vol) =>
                    vol.Name.includes(volumeName),
                );

                // noinspection JSUnresolvedReference
                return {
                    name: volumeName,
                    size: volumeData ? volumeData.Size : '0B',
                };
            });

            loader.stop();

            const table = new Table({
                head: [chalk.blue('Volume Name'), chalk.blue('Size')],
                colWidths: [40, 15],
            });

            // Add each volume to the table
            volumeSizes.forEach((volume) => {
                const size =
                    volume.size === '0B'
                        ? chalk.red('n/a')
                        : chalk.green(volume.size);
                table.push([chalk.yellow(volume.name), size]);
            });

            // Display the table
            console.log(table.toString());
        } catch (error) {
            loader.stop();
            console.log(
                chalk.red('Error retrieving volume sizes:'),
                error.message,
            );
        }
    }

    /**
     * Checks if the cwd has the `appwrite` folder.
     */
    static #checkForAppwriteFolder() {
        const appwritePath = path.join(
            process.cwd(),
            'appwrite',
            'docker-compose.yml',
        );

        if (fs.existsSync(appwritePath)) {
            console.log(chalk.green('✅ Appwrite directory detected.'));
            return true;
        } else {
            console.error(
                chalk.red(
                    '❌ Appwrite directory not detected in the current directory.',
                ),
            );
            return false;
        }
    }

    /**
     * Performs the backup of appwrite volumes.
     *
     * @see appwriteVolumes
     */
    static async #performBackup() {
        console.log('\n');

        while (!this.#backupType || this.#backupType.length === 0) {
            const response = await inquirer.prompt([
                {
                    type: 'checkbox',
                    name: 'backupType',
                    message: 'Select the type of backup',
                    choices: backupTypes,
                },
            ]);

            this.#backupType = response.backupType[0];
        }

        if (this.#backupType === 'cold-backup') {
            loader.start(chalk.blue('Stopping Appwrite services...'));
            try {
                await execa('docker', ['compose', 'down'], {
                    cwd: path.join(process.cwd(), 'appwrite'),
                });

                loader.stop();
                console.log(chalk.green('✅ Appwrite services stopped.'));
            } catch (error) {
                loader.stop();

                console.log(
                    chalk.red('❌ Error stopping Appwrite services:'),
                    error.message,
                );
                return;
            }
        } else if (this.#backupType === 'semi-hot-backup') {
            loader.start(chalk.blue('Pausing Appwrite services...'));
            try {
                await execa('docker', ['compose', 'pause'], {
                    cwd: path.join(process.cwd(), 'appwrite'),
                });

                loader.stop();
                console.log(chalk.green('✅ Appwrite services paused.'));
            } catch (error) {
                loader.stop();

                if (!error.message.includes('already paused')) {
                    console.log(
                        chalk.red('❌ Error pausing Appwrite services:'),
                        error.message,
                    );
                    return;
                }
            }
        }

        try {
            loader.start('Starting backup process...');

            const backupPath = path.join(process.cwd(), 'backups');
            if (!fs.existsSync(backupPath)) {
                fs.mkdirSync(backupPath);
            }

            await execa('docker', [
                'run',
                '--rm',
                ...appwriteVolumes.flatMap((volume) => [
                    '-v',
                    `${volume}:/backup/${volume}`,
                ]),
                '-v',
                `${path.join(process.cwd(), 'appwrite', '.env')}:/backup/appwrite/.env`,
                '-v',
                `${path.join(process.cwd(), 'appwrite', 'docker-compose.yml')}:/backup/appwrite/docker-compose.yml`,
                '-v',
                `${backupPath}:/archive`,
                '--env',
                'BACKUP_FILENAME=backup-%Y-%m-%dT%H-%M-%S.tar.gz',
                '--entrypoint',
                'backup',
                'offen/docker-volume-backup:latest',
            ]);

            loader.stop();

            console.log(chalk.green('✅ Backup completed successfully.'));
        } catch (error) {
            loader.stop();

            console.log(
                chalk.red('❌ Error during backup process:'),
                error.message,
            );
        }
    }
}
