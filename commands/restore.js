import * as fs from 'fs';
import chalk from 'chalk';
import { execa } from 'execa';
import * as path from 'path';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteVolumes,
    checkDocker,
    restartAppwriteStack,
} from '../utils/misc.js';

const loader = loading('');

export default class Restore {
    /**
     * The restore command for `yargs` to manage.
     */
    static yargsCommand() {
        return {
            command: 'restore',
            description:
                'Select a backup to restore your Appwrite instance with all volumes and SQL data!',
            builder: (_) => null,
            handler: async (_) => await this.#performTask(),
        };
    }

    /**
     * Starts task once yargs receives the command.
     */
    static async #performTask() {
        if (!(await checkDocker(loader))) return;

        if (await this.#checkIfAppwriteRemnantExists()) {
            const backupFilePath = await this.#listBackupFiles();
            await this.#copyBackupFile(backupFilePath);
            await this.#performRestore();
            await restartAppwriteStack(loader);
        }
    }

    /**
     * Checks if there are previous appwrite images, volumes and container.
     */
    static async #checkIfAppwriteRemnantExists() {
        const remnantsExist = await this.#detectAppwriteRemnants();

        if (!remnantsExist) {
            console.log(chalk.green('✅ No Appwrite remnants detected.'));
            return true;
        }

        console.log('\n');

        const { shouldDelete } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'shouldDelete',
                message:
                    'Appwrite remnants detected. Do you want to remove them for a clean installation?',
                default: true,
            },
        ]);

        if (shouldDelete) {
            await this.#deleteAppwriteRemnants();
            console.log(chalk.green('✅ Appwrite remnants removed.'));
        } else {
            console.log(
                chalk.yellow('⚠️  Restoration requires a clean install.'),
            );
            process.exit(1);
        }

        return true;
    }

    /**
     * Checks if there are previous appwrite images, volumes and container.
     */
    static async #detectAppwriteRemnants() {
        // Initialize an empty array to store remnants information
        const remnants = [];

        try {
            // Check for Appwrite-related containers
            const { stdout: containers } = await execa('docker', [
                'ps',
                '-a',
                '--filter',
                'name=appwrite',
                '--format',
                '{{.Names}}',
            ]);
            if (containers) {
                containers.split('\n').forEach((container) => {
                    if (container)
                        remnants.push({ name: container, type: 'Container' });
                });
            }

            // Check for Appwrite-related volumes
            const { stdout: volumes } = await execa('docker', [
                'volume',
                'ls',
                '--filter',
                'name=appwrite',
                '--format',
                '{{.Name}}',
            ]);
            if (volumes) {
                volumes.split('\n').forEach((volume) => {
                    if (volume) remnants.push({ name: volume, type: 'Volume' });
                });
            }

            const appwritePath = path.join(process.cwd(), 'appwrite');
            if (fs.existsSync(appwritePath)) {
                remnants.push({ name: appwritePath, type: 'Folder' });
            }

            // If no remnants were found, return false
            if (remnants.length === 0) {
                return false;
            }

            // Display remnants in a table
            const table = new Table({
                head: [chalk.blue('Name'), chalk.blue('Type')],
                colWidths: [50, 15],
            });

            remnants.forEach((remnant) =>
                table.push([
                    chalk.yellow(remnant.name),
                    chalk.green(remnant.type),
                ]),
            );

            console.log(chalk.blue('\nDetected Appwrite Remnants:\n'));
            console.log(table.toString());

            return true;
        } catch (error) {
            console.error(
                chalk.red('Error checking for Appwrite remnants:'),
                error.message,
            );
            return false;
        }
    }

    /**
     * Deletes the appwrite remnants if found.
     */
    static async #deleteAppwriteRemnants() {
        try {
            // Remove Appwrite-related containers
            const { stdout: containerIds } = await execa('docker', [
                'ps',
                '-a',
                '--filter',
                'label=com.docker.compose.project=appwrite',
                '--format',
                '{{.ID}}',
            ]);
            if (containerIds) {
                const containerList = containerIds
                    .split('\n')
                    .filter((id) => id);
                await execa('docker', [
                    'rm',
                    '-f',
                    ...containerList.map(String),
                ]);
                console.log(chalk.green('✅ Appwrite containers removed.'));
            } else {
                console.log(
                    chalk.yellow('✅ No Appwrite containers found to remove.'),
                );
            }

            // Remove Appwrite-related volumes
            const { stdout: volumeNames } = await execa('docker', [
                'volume',
                'ls',
                '--filter',
                'name=appwrite',
                '--format',
                '{{.Name}}',
            ]);
            if (volumeNames) {
                const volumeList = volumeNames
                    .split('\n')
                    .filter((name) => name);
                await execa('docker', [
                    'volume',
                    'rm',
                    '-f',
                    ...volumeList.map(String),
                ]);
                console.log(chalk.green('✅ Appwrite volumes removed.'));
            } else {
                console.log(
                    chalk.yellow('✅ No Appwrite volumes found to remove.'),
                );
            }

            // Remove Appwrite-related images
            const { stdout: imageIds } = await execa('docker', [
                'images',
                '--filter',
                'reference=appwrite/*',
                '--format',
                '{{.ID}}',
            ]);
            if (imageIds) {
                const imageList = imageIds.split('\n').filter((id) => id);
                await execa('docker', ['rmi', '-f', ...imageList.map(String)]);
                console.log(chalk.green('✅ Appwrite images removed.'));
            } else {
                console.log(
                    chalk.yellow('✅ No Appwrite images found to remove.'),
                );
            }

            // Remove Appwrite folder
            const appwritePath = path.join(process.cwd(), 'appwrite');
            if (fs.existsSync(appwritePath)) {
                fs.rmSync(appwritePath, { recursive: true, force: true });
                console.log(chalk.green('✅ Appwrite folder removed.'));
            } else {
                console.log(
                    chalk.yellow('✅ No Appwrite folder found to remove.'),
                );
            }
        } catch (error) {
            console.error(
                chalk.red('Error removing Appwrite remnants:'),
                error.message,
            );
        }
    }

    /**
     * Select a backup from a list of available backups, if any.
     */
    static async #listBackupFiles() {
        const backupPath = path.join(process.cwd(), 'backups');
        if (!fs.existsSync(backupPath)) {
            console.log(chalk.red('❌ No backups directory found.'));
            return null;
        }

        const files = fs
            .readdirSync(backupPath)
            .filter(
                (file) =>
                    file.startsWith('backup-') && file.endsWith('.tar.gz'),
            );

        if (files.length === 0) {
            console.log(chalk.red('❌ No backup files found.'));
            return null;
        }

        const backups = files.map((file) => {
            const baseName = file.replace('.tar.gz', '');

            const dateMatch = baseName.match(
                /backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
            );

            if (!dateMatch) {
                return { name: file, displayDate: 'Unknown' };
            }

            const [, year, month, day, hour, minute] = dateMatch;

            const hourInt = parseInt(hour, 10);
            const period = hourInt >= 12 ? 'PM' : 'AM';
            const formattedHour = ((hourInt + 11) % 12) + 1; // Convert to 12-hour format
            const formattedDate = `${day}/${month}/${year} @ ${formattedHour}:${minute} ${period}`;

            return { name: file, displayDate: formattedDate };
        });

        console.log('\n');

        let selectedBackup;

        while (!selectedBackup || selectedBackup.length === 0) {
            const response = await inquirer.prompt([
                {
                    type: 'checkbox',
                    name: 'selectedBackup',
                    message: 'Select a backup file to restore:',
                    choices: backups.map((b) => ({
                        name: `${b.name} (${b.displayDate})`,
                        value: b.name,
                    })),
                    validate: (input) =>
                        input.length > 0 ||
                        'Please select at least one backup file.',
                },
            ]);

            selectedBackup = response.selectedBackup;
        }

        return path.join(backupPath, selectedBackup[0]);
    }

    /**
     * Copies the backup file to cwd for restoration.
     */
    static async #copyBackupFile(backupFilePath) {
        if (!backupFilePath) {
            console.log(chalk.red('❌ No backup file selected.'));
            return;
        }

        const destinationPath = path.join(process.cwd(), 'backup.tar.gz');
        fs.copyFileSync(backupFilePath, destinationPath);
        console.log(
            chalk.green(
                '✅ Backup file copied to the current directory for restoration.',
            ),
        );
    }

    /**
     * Performs a complete restore.
     */
    static async #performRestore() {
        const tmpDir = '/tmp/backup';
        const appwriteDir = path.join(process.cwd(), 'appwrite');
        const backupFilePath = path.join(process.cwd(), 'backup.tar.gz');

        if (!fs.existsSync(backupFilePath)) {
            console.log(
                chalk.red(
                    '❌ Backup file "backup.tar.gz" not found in the current directory.',
                ),
            );
            return;
        }

        // Step 2: Extract the backup file
        loader.start(chalk.blue('Extracting backup...'));
        fs.mkdirSync(tmpDir, { recursive: true });
        await execa('tar', ['-C', '/tmp', '-xvf', backupFilePath]);

        loader.stop();

        // Step 3: Run a temporary container with mounted volumes for data restoration
        loader.start(
            chalk.blue('Setting up temporary container for restoration...'),
        );
        try {
            await execa('docker', [
                'run',
                '-d',
                '--name',
                'temp_restore_container',
                ...this.#getVolumeMappings(),
                '-v',
                `${appwriteDir}:/backup_restore/appwrite`,
                'alpine',
                'tail',
                '-f',
                '/dev/null',
            ]);

            loader.stop();

            // Step 4: Copy data from extracted backup into the container’s volumes
            loader.start(chalk.blue('Copying backup data into volumes...'));
            await execa('docker', [
                'cp',
                `${tmpDir}/.`,
                'temp_restore_container:/backup_restore',
            ]);
            loader.stop();
        } catch (error) {
            console.error(
                chalk.red('❌ Error during data restoration:'),
                error.message,
            );
            return;
        } finally {
            // delete the backup irrespective of the state.
            fs.rmSync(backupFilePath, { force: true });
        }

        // Step 5: Clean up temporary container and files
        loader.start(chalk.blue('Cleaning up temporary resources...'));
        await execa('docker', ['stop', 'temp_restore_container']);
        await execa('docker', ['rm', 'temp_restore_container']);
        fs.rmSync(tmpDir, { recursive: true, force: true });

        loader.stop();

        console.log(chalk.green('✅ Restoration completed successfully.'));
    }

    /**
     * Returns the volume mappings for restore.
     */
    static #getVolumeMappings() {
        return appwriteVolumes.flatMap((volume) => [
            '-v',
            `${volume}:/backup_restore/${volume}`,
        ]);
    }
}
