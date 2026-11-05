import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteDir,
    backupTypes,
    checkDocker,
    composeSteps,
    docker,
    dockerSync,
    handleInterrupts,
    helperArgs,
    installFiles,
    printError,
    runCompose,
    signalExitCode,
} from '../utils/misc.js';
import {
    movePath,
    newBackupFile,
    partialFile,
    plainPartial,
    readPassphrase,
    removePath,
    removePathSync,
    warnPartialArchives,
} from '../utils/archives.js';
import { readBackupCompose } from '../utils/compose.js';
import { acquireLock } from '../utils/lock.js';
import {
    inspectDatabase,
    removeSnapshot,
    removeSnapshotSync,
    snapshotDatabase,
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

        console.log('\n');

        const { backupType } = await inquirer.prompt([
            {
                type: 'select',
                name: 'backupType',
                message: 'Select the type of backup',
                choices: backupTypes,
            },
        ]);

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
            if (!volumes.includes(database.volume)) {
                throw new Error(
                    `${database.adapter.name}'s volume "${database.volume}" does not exist.`,
                );
            }
            measure = await measureVolumes(
                volumes,
                database.volume,
                database.adapter.skipped,
            );
            loader.stop();
        } catch (error) {
            loader.stop();
            printError('Error checking volume sizes:', error);
            process.exitCode = 1;
            return;
        }

        printVolumeSizes(measure, compose.volumes, compose.excluded);

        await this.#performBackup(
            backupType,
            database,
            volumes,
            measure,
            passphrase,
        );
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
            console.log(
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
     * @param type the type's value, from {@link backupTypes}.
     * @param database the database's `adapter`, `container` & `volume` names.
     * @param volumes the existing Appwrite volumes.
     * @param measure volume sizes & free disk space, from {@link measureVolumes}.
     * @param passphrase encrypts the archive, if any.
     */
    static async #performBackup(type, database, volumes, measure, passphrase) {
        const { name } = database.adapter;
        // hot backups keep Appwrite running, a live copy of the database's files would be torn, so snapshot it first.
        // files are copied after it: new uploads become orphans, deleted ones may be missing.
        const hot = type === 'hot-backup';
        let state = null;
        if (hot) {
            state = await inspectDatabase(database.container);

            if (state?.status !== 'running') {
                console.log(
                    chalk.red(
                        `❌ Hot backups need a running ${name}, its container is ${state?.status ?? 'missing'}. Try a semi-hot or cold backup instead.`,
                    ),
                );
                process.exitCode = 1;
                return;
            }
        }

        const space = checkDiskSpace(
            measure,
            database.volume,
            hot,
            Boolean(passphrase),
            Boolean(database.adapter.dumpFile),
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
        const snapshot = `abr-db-snapshot-${id}`;
        const archive = `abr-archive-${id}`;
        const file = newBackupFile(Boolean(passphrase));
        // `command` is the running stop, pause or bring back, killed on a forced exit.
        const stack = { stopped: false, paused: false, command: null };
        const controller = new AbortController();
        const { signal } = controller;
        let archived = false;
        let interrupted = 0;

        // on interrupt, abort & let `finally` clean up & bring Appwrite back. a second one exits within seconds:
        // no backup keeps running & no plain archive stays.
        const release = handleInterrupts((received) => {
            loader.stop();
            if (interrupted) {
                stack.command?.kill();
                // containers first, so they can't write again. `-v` also takes their anonymous volumes.
                dockerSync(['rm', '-f', '-v', snapshot, archive]);
                const partial = partialFile(file);
                removePathSync(partial);
                // offen's plain archive, if it got no passphrase.
                if (passphrase) removePathSync(plainPartial(partial));
                if (hot) removeSnapshotSync(snapshot, archive);
                this.#warnAppwriteDown(stack);
                process.exit(interrupted);
            }
            interrupted = signalExitCode(received);
            controller.abort();
        });

        try {
            if (
                hot &&
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

            if (!(await this.#stopAppwrite(type, stack)) || signal.aborted) {
                return;
            }

            archived = await this.#archiveVolumes({
                volumes,
                files: [...new Set([...installFiles, ...database.files])],
                replace: hot && { [database.volume]: snapshot },
                archive,
                file,
                passphrase,
                signal,
            });
        } finally {
            if (hot) await removeSnapshot(snapshot, archive);
            if (stack.stopped) {
                stack.stopped = !(await runCompose(
                    loader,
                    composeSteps.restart,
                    stack,
                ));
            }
            if (stack.paused) {
                stack.paused = !(await runCompose(
                    loader,
                    composeSteps.resume,
                    stack,
                ));
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
        const message =
            'The size is estimated without compression, the archive may still fit. If a disk fills up, Appwrite may fail writes until space is freed.';
        // piped input isn't someone accepting that.
        if (!process.stdin.isTTY) {
            console.log(chalk.red(`❌ Not enough disk space. ${message}`));
            return false;
        }

        const { proceed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                // every type has Appwrite running again on these disks afterwards.
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
    static async #stopAppwrite(type, stack) {
        // marked first, a failed stop may have stopped some services.
        // not cancelled on interrupt, a half stopped stack is harder to bring back.
        if (type === 'cold-backup') {
            stack.stopped = true;
            return runCompose(loader, composeSteps.stop, stack);
        }
        if (type === 'semi-hot-backup') {
            stack.paused = true;
            return runCompose(loader, composeSteps.pause, stack);
        }
        return true;
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
     * @param options.files files to archive from the `appwrite` folder.
     * @param options.replace volumes to archive from another volume, e.g. the database's snapshot.
     * @param options.archive name for the archive container, to stop it on failure or interrupt.
     * @param options.file path of the archive to create.
     * @param options.passphrase encrypts the archive via GPG, if any.
     * @param options.signal aborts the archiving.
     * @returns {Promise<boolean>} `true` if the archive was created.
     */
    static async #archiveVolumes({
        volumes,
        files,
        replace,
        archive,
        file,
        passphrase,
        signal,
    }) {
        // a truncated archive would be listed by restore, so it's only moved to its final name once complete.
        const partial = partialFile(file);
        const plain = plainPartial(partial);

        try {
            loader.start('Starting backup process...');
            await docker(
                helperArgs({
                    entrypoint: 'backup',
                    name: archive,
                    mounts: [
                        ...volumes.map(
                            (volume) =>
                                `${replace?.[volume] ?? volume}:/backup/${volume}`,
                        ),
                        ...files.map(
                            (name) =>
                                `${path.join(appwriteDir(), name)}:/backup/appwrite/${name}`,
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
        if (signal.aborted) {
            await removePath(partial);
            return false;
        }

        try {
            await movePath(partial, file);
        } catch (error) {
            printError(
                `The backup is complete, but could not be renamed from "${path.basename(partial)}":`,
                error,
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
}
