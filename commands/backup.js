import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteDir,
    backupTypes,
    checkDocker,
    docker,
    dockerSync,
    handleInterrupts,
    helperArgs,
    installFiles,
    restartAppwriteStack,
    resumeAppwriteStack,
    signalExitCode,
} from '../utils/misc.js';
import {
    movePath,
    newBackupFile,
    partialFile,
    readPassphrase,
    removePath,
    removePathSync,
    warnPartialArchives,
} from '../utils/archives.js';
import { readBackupCompose } from '../utils/compose.js';
import { acquireLock } from '../utils/lock.js';
import {
    inspectDatabase,
    isVolumeUsedByOthers,
    listDatabaseFiles,
    removeSnapshot,
    removeSnapshotSync,
    snapshotDatabase,
    snapshotName,
    warnLeftoverSnapshots,
} from '../utils/adapters/index.js';
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
            builder: (yargs) =>
                yargs.option('encrypt', {
                    type: 'boolean',
                    description:
                        'Encrypt the backup with a passphrase, from ABR_GPG_PASSPHRASE or a prompt',
                }),
            handler: async (argv) => await this.#performTask(argv),
        };
    }

    /**
     * Starts task once yargs receives the command.
     */
    static async #performTask({ encrypt }) {
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
        const { database } = compose;
        const { name } = database.adapter;

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

        if (!encrypt && process.env.ABR_GPG_PASSPHRASE) {
            console.log(
                chalk.yellow(
                    '⚠️  ABR_GPG_PASSPHRASE is set, but the backup is only encrypted with --encrypt.',
                ),
            );
        }

        // asked before Appwrite is stopped or paused.
        const passphrase = encrypt ? await readPassphrase(true) : null;
        if (encrypt && !passphrase) {
            process.exitCode = 1;
            return;
        }

        // measured after the prompt, the disk check needs current numbers.
        loader.start('Checking volume sizes...');
        let volumes;
        let measure;
        try {
            volumes = await existingVolumes(compose.volumes);
            if (volumes.includes(database.volume)) {
                measure = await measureVolumes(volumes, database.volume);
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
        if (!volumes.includes(database.volume)) {
            console.log(
                chalk.red(
                    `❌ ${name}'s volume "${database.volume}" does not exist.`,
                ),
            );
            process.exitCode = 1;
            return;
        }

        printVolumeSizes(measure, compose.volumes, compose.excluded);

        await this.#performBackup(database, volumes, measure, passphrase);
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
     * @param database the database's `adapter`, `container` & `volume` names.
     * @param volumes the existing Appwrite volumes.
     * @param measure volume sizes & free disk space, from {@link measureVolumes}.
     * @param passphrase encrypts the archive, if any.
     */
    static async #performBackup(database, volumes, measure, passphrase) {
        const { name } = database.adapter;
        // hot backups keep Appwrite running, a live copy of the database's files would be torn, so snapshot it first.
        // files are copied after it: new uploads become orphans, deleted ones may be missing.
        let snapshotted = false;
        let state = null;
        let asIs = false;
        if (this.#backupType === 'hot-backup') {
            let usedByOthers;
            try {
                [state, usedByOthers] = await Promise.all([
                    inspectDatabase(database.container),
                    isVolumeUsedByOthers(database),
                ]);
            } catch (error) {
                console.log(
                    chalk.red(`❌ Could not inspect ${name}:`),
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
                        `⚠️  ${name} is ${status}, copying its volume as is.`,
                    ),
                );
                asIs = true;
            } else {
                const reason = usedByOthers
                    ? `it is ${status} but its volume is used by another container`
                    : `it is ${status}`;
                console.log(
                    chalk.red(
                        `❌ Cannot back up ${name}, ${reason}. Try a semi-hot or cold backup instead.`,
                    ),
                );
                process.exitCode = 1;
                return;
            }
        }

        const space = checkDiskSpace(
            measure,
            database.volume,
            snapshotted,
            Boolean(passphrase),
        );
        if (space === 'snapshot') {
            console.log(
                chalk.red(
                    `❌ Not enough disk space in Docker’s storage for the ${name} snapshot & its compressed copy.`,
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
        const file = newBackupFile(Boolean(passphrase));
        // `command` is the running stop, pause or bring back, killed on a forced exit.
        const stack = { stopped: false, paused: false, command: null };
        const controller = new AbortController();
        const { signal } = controller;
        let archived = false;
        let interrupted = 0;

        // on interrupt, abort & let `finally` clean up & bring Appwrite back. a second one exits right away.
        const release = handleInterrupts((name) => {
            loader.stop();
            if (interrupted) {
                if (snapshot) removeSnapshotSync(snapshot, archive);
                else dockerSync(['rm', '-f', archive], { reject: false });
                removePathSync(partialFile(file));
                // offen's plain archive, if it got no passphrase.
                if (passphrase) {
                    removePathSync(partialFile(file).replace(/\.gpg$/, ''));
                }
                stack.command?.kill();
                this.#warnAppwriteDown(stack);
                const down = stack.stopped || stack.paused;
                process.exit(
                    archived && !down ? (process.exitCode ?? 0) : interrupted,
                );
            }
            interrupted = signalExitCode(name);
            controller.abort();
        });

        try {
            if (
                snapshot &&
                !(await snapshotDatabase(
                    loader,
                    { ...database, ...state },
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
                    files = await listDatabaseFiles(database);
                } catch (error) {
                    console.log(
                        chalk.red(`❌ Could not list ${name}’s files:`),
                        error.stderr?.trim() || error.message,
                    );
                    process.exitCode = 1;
                    return;
                }
            }
            if (signal.aborted) return;

            archived = await this.#archiveVolumes({
                volumes,
                replace: snapshot && { [database.volume]: snapshot },
                archive,
                file,
                passphrase,
                signal,
                verify:
                    files !== null &&
                    (async () => (await listDatabaseFiles(database)) === files),
            });
        } finally {
            if (snapshot) await removeSnapshot(snapshot, archive);
            const track = (command) => (stack.command = command);
            if (stack.stopped) {
                stack.stopped = !(await restartAppwriteStack(loader, track));
            }
            if (stack.paused) {
                stack.paused = !(await resumeAppwriteStack(loader, track));
            }
            this.#warnAppwriteDown(stack);
            // an interrupt during the final cleanup doesn't undo a finished backup.
            if (interrupted && !archived) {
                process.exitCode = interrupted;
                console.log(chalk.yellow('⚠️  Backup interrupted.'));
            }
            release();
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
     * @param options.replace volumes to archive from another volume, e.g. the database's snapshot.
     * @param options.archive name for the archive container, to stop it on failure or interrupt.
     * @param options.file path of the archive to create.
     * @param options.passphrase encrypts the archive via GPG, if any.
     * @param options.signal aborts the archiving.
     * @param options.verify checks the archive before it's kept, removed if it returns `false`.
     * @returns {Promise<boolean>} `true` if the archive was created.
     */
    static async #archiveVolumes({
        volumes,
        replace,
        archive,
        file,
        passphrase,
        signal,
        verify,
    }) {
        // a truncated archive would be listed by restore, so it's only moved to its final name once complete.
        const partial = partialFile(file);
        // offen's name for the archive, before it appends `.gpg`. a plain one, if it got no passphrase.
        const plain = partial.replace(/\.gpg$/, '');

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
                    // offen appends `.gpg` to encrypted archives.
                    // the passphrase via stdin, as env `docker inspect` would show it.
                    env: [
                        `BACKUP_FILENAME=${path.basename(plain)}`,
                        ...(passphrase
                            ? ['GPG_PASSPHRASE_FILE=/dev/stdin']
                            : []),
                    ],
                    extra: passphrase ? ['-i'] : [],
                }),
                { cancelSignal: signal, input: passphrase || undefined },
            );
            loader.stop();
        } catch (error) {
            loader.stop();

            // stop the container first so it can't write again.
            await docker(['rm', '-f', archive], { reject: false });
            await removePath(partial);
            // offen's plain archive, if it got no passphrase.
            if (passphrase) await removePath(plain);
            if (signal.aborted) return false;

            console.log(
                chalk.red('❌ Error during backup process:'),
                error.message,
            );
            process.exitCode = 1;
            return false;
        }

        // offen writes a plain archive without a passphrase, never keep that as encrypted.
        if (passphrase && !fs.existsSync(partial)) {
            const removed = await removePath(plain);
            console.log(
                chalk.red(
                    removed
                        ? '❌ The archive was not encrypted, it was removed.'
                        : `❌ The archive was not encrypted, remove "${plain}".`,
                ),
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
                chalk.red('❌ Could not check the database’s files:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        console.log(
            chalk.red(
                '❌ The database wrote to its volume during the backup, the copy may be torn and was removed. Try again or use a cold backup.',
            ),
        );
        return false;
    }
}
