import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteDir,
    appwriteVolumes,
    backupTypes,
    checkDocker,
    docker,
    dockerSync,
    helperArgs,
    installFiles,
    restartAppwriteStack,
    resumeAppwriteStack,
    setHandlingInterrupts,
    signalExitCode,
} from '../utils/misc.js';
import {
    movePath,
    newBackupFile,
    partialFile,
    removePath,
    removePathSync,
    warnPartialArchives,
} from '../utils/archives.js';
import { readBackupCompose } from '../utils/compose.js';
import { acquireLock } from '../utils/lock.js';
import {
    inspectMariaDB,
    isMariaDBVolumeUsedByOthers,
    listMariaDBFiles,
    removeMariaDBSnapshot,
    removeMariaDBSnapshotSync,
    snapshotMariaDB,
    snapshotName,
    warnLeftoverSnapshots,
} from '../utils/mariadb.js';
import {
    checkDiskSpace,
    existingVolumes,
    measureVolumes,
    printVolumeSizes,
} from '../utils/volumes.js';

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

        if (
            !(await checkDocker(loader)) ||
            !this.#checkForAppwriteFolder() ||
            !(await acquireLock())
        ) {
            process.exitCode = 1;
            return;
        }
        await warnLeftoverSnapshots();
        warnPartialArchives();

        const compose = await readBackupCompose();
        if (!compose) {
            process.exitCode = 1;
            return;
        }
        const { mariadb } = compose;

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

        // measured after the prompt, the disk check needs current numbers.
        loader.start('Checking volume sizes...');
        let volumes;
        let measure;
        try {
            volumes = await existingVolumes(appwriteVolumes);
            if (volumes.includes(mariadb.volume)) {
                measure = await measureVolumes(volumes, mariadb.volume);
            }
            loader.stop();
        } catch (error) {
            loader.stop();
            console.log(
                chalk.red('❌ Error checking volume sizes:'),
                error.stderr?.trim() || error.message,
            );
            process.exitCode = 1;
            return;
        }
        if (!volumes.includes(mariadb.volume)) {
            console.log(
                chalk.red(
                    `❌ MariaDB's volume "${mariadb.volume}" does not exist.`,
                ),
            );
            process.exitCode = 1;
            return;
        }

        printVolumeSizes(measure, appwriteVolumes);

        await this.#performBackup(mariadb, volumes, measure);
        this.#backupType = '';
    }

    /**
     * Checks if the cwd has the `appwrite` folder.
     */
    static #checkForAppwriteFolder() {
        // `.env` too, `docker run -v` would create it as a folder.
        if (
            installFiles.every((file) =>
                fs.existsSync(path.join(appwriteDir(), file)),
            )
        ) {
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
     * @param mariadb MariaDB's `container` & `volume` names.
     * @param volumes the existing Appwrite volumes.
     * @param measure volume sizes & free disk space, from {@link measureVolumes}.
     */
    static async #performBackup(mariadb, volumes, measure) {
        // hot backups keep Appwrite running, a live copy of MariaDB's files would be torn, so snapshot it first.
        // files are copied after it: new uploads become orphans, deleted ones may be missing.
        let snapshotted = false;
        let state = null;
        let asIs = false;
        if (this.#backupType === 'hot-backup') {
            let usedByOthers;
            try {
                [state, usedByOthers] = await Promise.all([
                    inspectMariaDB(mariadb.container),
                    isMariaDBVolumeUsedByOthers(mariadb),
                ]);
            } catch (error) {
                console.log(
                    chalk.red('❌ Could not inspect MariaDB:'),
                    error.message,
                );
                process.exitCode = 1;
                return;
            }

            // not writing, so its volume is consistent as is, checked after the copy.
            // a missing container is e.g. after `compose down`.
            const status = state?.status ?? 'missing';
            const stopped = ['exited', 'created', 'dead', 'paused', 'missing'];
            if (status === 'running') {
                snapshotted = true;
            } else if (stopped.includes(status) && !usedByOthers) {
                console.log(
                    chalk.yellow(
                        `⚠️  MariaDB is ${status}, copying its volume as is.`,
                    ),
                );
                asIs = true;
            } else {
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
        }

        const space = checkDiskSpace(measure, mariadb.volume, snapshotted);
        if (space === 'snapshot') {
            console.log(
                chalk.red(
                    '❌ Not enough disk space in Docker’s storage for the MariaDB snapshot & its compressed copy.',
                ),
            );
            process.exitCode = 1;
            return;
        }
        if (space === 'archive' && !(await this.#confirmLowSpace())) {
            process.exitCode = 1;
            return;
        }

        const id = Date.now();
        const snapshot = snapshotted ? snapshotName(id) : null;
        const archive = `abr-archive-${id}`;
        const file = newBackupFile();
        // `command` is the running stop, pause or bring back, killed on a forced exit.
        const stack = { stopped: false, paused: false, command: null };
        const controller = new AbortController();
        const { signal } = controller;
        let archived = false;
        let interrupted = 0;

        // on interrupt, abort & let `finally` clean up & bring Appwrite back. a second one exits right away.
        // `on`, not `once`: execa's exit hook re-raises the signal if no other listener is left.
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
        const onInterrupt = (name) => {
            loader.stop();
            if (interrupted) {
                if (snapshot) removeMariaDBSnapshotSync(snapshot, archive);
                else dockerSync(['rm', '-f', archive], { reject: false });
                removePathSync(partialFile(file));
                stack.command?.kill();
                this.#warnAppwriteDown(stack);
                const down = stack.stopped || stack.paused;
                process.exit(
                    archived && !down ? (process.exitCode ?? 0) : interrupted,
                );
            }
            interrupted = signalExitCode(name);
            controller.abort();
        };
        signals.forEach((name) => process.on(name, onInterrupt));
        setHandlingInterrupts(true);

        // a hung up terminal (SIGHUP) fails writes with EIO, don't crash before the cleanup.
        const ignore = () => {};
        process.stdout.on('error', ignore);
        process.stderr.on('error', ignore);

        try {
            if (
                snapshot &&
                !(await snapshotMariaDB(
                    loader,
                    { ...mariadb, ...state },
                    snapshot,
                    signal,
                ))
            ) {
                if (!signal.aborted) process.exitCode = 1;
                return;
            }

            if (!(await this.#stopAppwrite(stack)) || signal.aborted) return;

            // listed right before the copy, to compare with after it.
            let files = null;
            if (asIs) {
                try {
                    files = await listMariaDBFiles(mariadb);
                } catch (error) {
                    console.log(
                        chalk.red('❌ Could not list MariaDB’s files:'),
                        error.stderr?.trim() || error.message,
                    );
                    process.exitCode = 1;
                    return;
                }
            }
            if (signal.aborted) return;

            archived = await this.#archiveVolumes({
                volumes,
                replace: snapshot && { [mariadb.volume]: snapshot },
                archive,
                file,
                signal,
                verify:
                    files !== null &&
                    (async () => (await listMariaDBFiles(mariadb)) === files),
            });
        } finally {
            if (snapshot) await removeMariaDBSnapshot(snapshot, archive);
            const track = (command) => (stack.command = command);
            if (stack.stopped) {
                stack.stopped = !(await restartAppwriteStack(loader, track));
            }
            if (stack.paused) {
                stack.paused = !(await resumeAppwriteStack(loader, track));
            }
            this.#warnAppwriteDown(stack);
            setHandlingInterrupts(false);
            signals.forEach((name) => process.off(name, onInterrupt));

            // an interrupt during the final cleanup doesn't undo a finished backup.
            if (interrupted && !archived) {
                process.exitCode = interrupted;
                console.log(chalk.yellow('⚠️  Backup interrupted.'));
            }

            process.stdout.off('error', ignore);
            process.stderr.off('error', ignore);
        }
    }

    /**
     * Asks whether to go ahead when the archive may not fit, `false` if declined or not interactive.
     */
    static async #confirmLowSpace() {
        // every type has Appwrite running again on these disks afterwards.
        const message =
            'The size is estimated without compression, the archive may still fit. If a disk fills up, Appwrite may fail writes until space is freed.';
        if (!process.stdin.isTTY) {
            console.log(chalk.red(`❌ Not enough disk space. ${message}`));
            return false;
        }

        const { proceed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: `${message} Continue anyway?`,
                default: false,
            },
        ]);
        return proceed;
    }

    /**
     * Stops or pauses Appwrite as per the backup type, marked in `stack` to bring it back after.
     *
     * @returns {Promise<boolean>} `false` if that failed.
     */
    static async #stopAppwrite(stack) {
        const cold = this.#backupType === 'cold-backup';
        if (!cold && this.#backupType !== 'semi-hot-backup') return true;

        // marked first, a failed stop may have stopped some services.
        if (cold) stack.stopped = true;
        else stack.paused = true;

        loader.start(
            chalk.blue(
                cold
                    ? 'Stopping Appwrite services...'
                    : 'Pausing Appwrite services...',
            ),
        );
        try {
            // not cancelled on interrupt, a half stopped stack is harder to bring back.
            stack.command = docker(['compose', cold ? 'down' : 'pause'], {
                cwd: appwriteDir(),
            });
            await stack.command;
            loader.stop();
            console.log(
                chalk.green(
                    cold
                        ? '✅ Appwrite services stopped.'
                        : '✅ Appwrite services paused.',
                ),
            );
            return true;
        } catch (error) {
            loader.stop();
            if (!cold && error.message.includes('already paused')) return true;

            console.log(
                chalk.red(
                    cold
                        ? '❌ Error stopping Appwrite services:'
                        : '❌ Error pausing Appwrite services:',
                ),
                error.message,
            );
            process.exitCode = 1;
            return false;
        }
    }

    /**
     * Tells how to bring Appwrite back, when a failure or forced exit leaves it stopped or paused.
     */
    static #warnAppwriteDown(stack) {
        if (!stack.stopped && !stack.paused) return;

        const [state, command] = stack.stopped
            ? ['stopped', 'docker compose up -d']
            : ['paused', 'docker compose unpause'];
        console.log(
            chalk.yellow(
                `⚠️  Appwrite is ${state}, bring it back via "${command}" in ${appwriteDir()}.`,
            ),
        );
    }

    /**
     * Archives the volumes.
     *
     * @param options.volumes volumes to archive.
     * @param options.replace volumes to archive from another volume, e.g. MariaDB's snapshot.
     * @param options.archive name for the archive container, to stop it on failure or interrupt.
     * @param options.file path of the archive to create.
     * @param options.signal aborts the archiving.
     * @param options.verify checks the archive before it's kept, removed if it returns `false`.
     * @returns {Promise<boolean>} `true` if the archive was created.
     */
    static async #archiveVolumes({
        volumes,
        replace,
        archive,
        file,
        signal,
        verify,
    }) {
        // a truncated archive would be listed by restore, so it's only moved to its final name once complete.
        const partial = partialFile(file);

        try {
            loader.start('Starting backup process...');
            await docker(
                helperArgs({
                    entrypoint: 'backup',
                    name: archive,
                    role: 'backup',
                    mounts: [
                        ...volumes.map(
                            (volume) =>
                                `${replace?.[volume] ?? volume}:/backup/${volume}`,
                        ),
                        ...installFiles.map(
                            (file) =>
                                `${path.join(appwriteDir(), file)}:/backup/appwrite/${file}`,
                        ),
                        `${path.dirname(file)}:/archive`,
                    ],
                    env: [`BACKUP_FILENAME=${path.basename(partial)}`],
                }),
                { cancelSignal: signal },
            );
            loader.stop();
        } catch (error) {
            loader.stop();

            // stop the container first so it can't write again.
            await docker(['rm', '-f', archive], { reject: false });
            await removePath(partial);
            if (signal.aborted) return false;

            console.log(
                chalk.red('❌ Error during backup process:'),
                error.message,
            );
            process.exitCode = 1;
            return false;
        }

        // a complete archive is still removed if the interrupt came first.
        const failed =
            !signal.aborted && verify && !(await this.#verifyArchive(verify));
        if (failed || signal.aborted) {
            await removePath(partial);
            if (failed) process.exitCode = 1;
            return false;
        }

        try {
            await movePath(partial, file);
        } catch (error) {
            console.log(
                chalk.red(
                    `❌ The backup is complete, but could not be renamed from "${path.basename(partial)}":`,
                ),
                error.stderr?.trim() || error.message,
            );
            console.log(
                chalk.yellow(
                    `⚠️  Rename it to restore it, e.g. via "sudo mv ${partial} ${file}".`,
                ),
            );
            process.exitCode = 1;
            return false;
        }

        console.log(chalk.green('✅ Backup completed successfully.'));
        return true;
    }

    /**
     * Runs the archive's `verify` check, prints why it failed.
     */
    static async #verifyArchive(verify) {
        try {
            if (await verify()) return true;
        } catch (error) {
            console.log(
                chalk.red('❌ Could not check MariaDB’s files:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        console.log(
            chalk.red(
                '❌ MariaDB wrote to its volume during the backup, the copy may be torn and was removed. Try again or use a cold backup.',
            ),
        );
        return false;
    }
}
