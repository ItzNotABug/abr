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
    mariadbVolume,
    restartAppwriteStack,
    resumeAppwriteStack,
} from '../utils/misc.js';
import {
    checkDatabaseAdapter,
    inspectMariaDB,
    isMariaDBVolumeUsedByOthers,
    removeMariaDBSnapshot,
    removeMariaDBSnapshotSync,
    snapshotLabel,
    snapshotMariaDB,
    snapshotName,
    warnLeftoverSnapshots,
} from '../utils/mariadb.js';

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

        if (!(await checkDocker(loader)) || !this.#checkForAppwriteFolder()) {
            process.exitCode = 1;
            return;
        }
        await warnLeftoverSnapshots();
        this.#warnPartialArchives();
        if (!(await checkDatabaseAdapter())) {
            process.exitCode = 1;
            return;
        }
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

        // hot backups keep Appwrite running, a live copy of MariaDB's files would be torn, so snapshot it first.
        // files are copied after it: new uploads become orphans, deleted ones may be missing.
        if (this.#backupType !== 'hot-backup') return this.#archiveVolumes();

        let mariadb;
        let usedByOthers;
        try {
            mariadb = await inspectMariaDB();
            usedByOthers = await isMariaDBVolumeUsedByOthers();
        } catch (error) {
            console.log(
                chalk.red('❌ Could not inspect MariaDB:'),
                error.message,
            );
            process.exitCode = 1;
            return;
        }
        const status = mariadb?.status ?? 'missing';
        const state = (current, used) =>
            `${current?.status}|${current?.startedAt}|${used}`;

        // not writing, so its volume is consistent as is, unless it starts during the copy.
        // a missing container is e.g. after `compose down`.
        if (
            ['exited', 'created', 'dead', 'paused', 'missing'].includes(
                status,
            ) &&
            !usedByOthers
        ) {
            console.log(
                chalk.yellow(
                    `⚠️  MariaDB is ${status}, copying its volume as is.`,
                ),
            );

            const before = state(mariadb, usedByOthers);
            return this.#archiveVolumes({
                verify: async () => {
                    const after = state(
                        await inspectMariaDB(),
                        await isMariaDBVolumeUsedByOthers(),
                    );
                    if (after === before) return true;

                    console.log(
                        chalk.red(
                            '❌ MariaDB changed state during the backup, the copy may be torn and was removed. Try again or use a cold backup.',
                        ),
                    );
                    process.exitCode = 1;
                    return false;
                },
            });
        }

        if (status !== 'running') {
            const reason = usedByOthers
                ? `it is ${status} but its volume is used by another container`
                : `it is ${status}`;
            console.log(
                chalk.red(
                    `❌ Cannot back up MariaDB, ${reason}. Try a semi-hot or cold backup instead.`,
                ),
            );
            process.exitCode = 1;
            return;
        }

        const snapshot = snapshotName();
        const archive = `${snapshot}-archive`;
        const file = this.#backupFile();
        const controller = new AbortController();
        let archived = false;

        // on interrupt, abort & let `finally` remove the snapshot, a plaintext database copy.
        // `on`, not `once`: execa's exit hook re-raises the signal if no other listener is left.
        const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
        let interruptCode;
        const onInterrupt = (signal) => {
            loader.stop();
            if (interruptCode) {
                removeMariaDBSnapshotSync(snapshot, archive);
                fs.rmSync(this.#partialFile(file), { force: true });
                process.exit(archived ? 0 : interruptCode);
            }
            interruptCode = signals[signal];
            controller.abort();
        };
        Object.keys(signals).forEach((signal) =>
            process.on(signal, onInterrupt),
        );

        // a hung up terminal (SIGHUP) fails writes with EIO, don't crash before the cleanup.
        const ignore = () => {};
        process.stdout.on('error', ignore);
        process.stderr.on('error', ignore);

        try {
            const snapshotted = await snapshotMariaDB(
                loader,
                mariadb,
                snapshot,
                controller.signal,
            );
            if (!snapshotted || controller.signal.aborted) {
                if (!controller.signal.aborted) process.exitCode = 1;
                return;
            }

            archived = Boolean(
                await this.#archiveVolumes({
                    snapshot,
                    archive,
                    file,
                    signal: controller.signal,
                }),
            );
        } finally {
            await removeMariaDBSnapshot(snapshot, archive);
            Object.keys(signals).forEach((signal) =>
                process.off(signal, onInterrupt),
            );
            process.stdout.off('error', ignore);
            process.stderr.off('error', ignore);

            // an interrupt during the final cleanup doesn't undo a finished backup.
            if (interruptCode && !archived) {
                process.exitCode = interruptCode;
                console.log(chalk.yellow('⚠️  Backup interrupted.'));
            }
        }
    }

    /**
     * Returns an unused path for a new backup archive, in the format restores list.
     */
    static #backupFile() {
        const timestamp = new Date()
            .toISOString()
            .slice(0, 19)
            .replaceAll(':', '-');
        const name = (suffix) =>
            path.join(
                process.cwd(),
                'backups',
                `backup-${timestamp}${suffix}.tar.gz`,
            );

        let file = name('');
        for (let i = 1; fs.existsSync(file); i++) file = name(`-${i}`);
        return file;
    }

    /**
     * Where offen writes the archive until it's complete, not listed by restores.
     */
    static #partialFile(file) {
        return path.join(path.dirname(file), `.partial-${path.basename(file)}`);
    }

    /**
     * Warns about incomplete archives left by killed runs, they can be large.
     */
    static #warnPartialArchives() {
        const backups = path.join(process.cwd(), 'backups');
        const partials = fs.existsSync(backups)
            ? fs
                  .readdirSync(backups)
                  .filter((file) => file.startsWith('.partial-'))
            : [];
        if (partials.length === 0) return;

        console.log(
            chalk.yellow(
                `⚠️  Found incomplete archives from interrupted backups in backups/. If no other backup is running, remove them: ${partials.join(', ')}.`,
            ),
        );
    }

    /**
     * Stops or pauses Appwrite as per the backup type and archives the volumes.
     *
     * @param options.snapshot MariaDB snapshot volume to archive instead of the live volume, if any.
     * @param options.archive Name for the archive container, to stop it on failure or abort.
     * @param options.file Path of the archive to create.
     * @param options.signal Aborts the archiving.
     * @param options.verify Checks the archive before it's kept, removed if it returns `false`.
     * @returns {Promise<string|null>} Path of the created archive, `null` on failure or abort.
     */
    static async #archiveVolumes({
        snapshot = null,
        archive = null,
        file = this.#backupFile(),
        signal = null,
        verify = null,
    } = {}) {
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
                process.exitCode = 1;
                return null;
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
                    process.exitCode = 1;
                    return null;
                }
            }
        }

        // a truncated archive would be listed by restore, which wipes the install before extracting.
        // so it's only moved to its final name once complete.
        const partial = this.#partialFile(file);

        try {
            loader.start('Starting backup process...');
            fs.mkdirSync(path.dirname(file), { recursive: true });

            await execa(
                'docker',
                [
                    'run',
                    '--rm',
                    ...(archive
                        ? ['--name', archive, '--label', snapshotLabel]
                        : []),
                    ...appwriteVolumes.flatMap((volume) => {
                        const source =
                            snapshot && volume === mariadbVolume
                                ? snapshot
                                : volume;
                        return ['-v', `${source}:/backup/${volume}`];
                    }),
                    '-v',
                    `${path.join(process.cwd(), 'appwrite', '.env')}:/backup/appwrite/.env`,
                    '-v',
                    `${path.join(process.cwd(), 'appwrite', 'docker-compose.yml')}:/backup/appwrite/docker-compose.yml`,
                    '-v',
                    `${path.dirname(file)}:/archive`,
                    '--env',
                    `BACKUP_FILENAME=${path.basename(partial)}`,
                    '--entrypoint',
                    'backup',
                    'offen/docker-volume-backup:latest',
                ],
                signal ? { cancelSignal: signal } : {},
            );

            loader.stop();

            if (verify && !(await verify())) {
                fs.rmSync(partial, { force: true });
                return null;
            }

            fs.renameSync(partial, file);
            console.log(chalk.green('✅ Backup completed successfully.'));
            return file;
        } catch (error) {
            loader.stop();

            // stop the container first so it can't write again.
            if (archive) {
                await execa('docker', ['rm', '-f', archive], { reject: false });
            }
            fs.rmSync(partial, { force: true });

            // the same Ctrl+C can fail the docker CLI before the abort handler runs.
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (signal?.aborted) return null;

            console.log(
                chalk.red('❌ Error during backup process:'),
                error.message,
            );
            process.exitCode = 1;
            return null;
        }
    }
}
