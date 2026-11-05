import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteDir,
    checkDocker,
    appwriteVolumeName,
    composeSteps,
    defaultVolumes,
    docker,
    helperArgs,
    installFiles,
    pullImage,
    runCompose,
    signalExitCode,
} from '../utils/misc.js';
import {
    isEncrypted,
    listBackups,
    readPassphrase,
    removePath,
    selectBackup,
} from '../utils/archives.js';
import { adapters } from '../utils/adapters/index.js';
import { cacheVolumes, readCompose } from '../utils/compose.js';
import { existingVolumes } from '../utils/volumes.js';
import { acquireLock } from '../utils/lock.js';

const loader = loading('');

/**
 * Extracts archives. GNU tar, busybox's ignores the PAX headers of files over 8 GB.
 */
const extractorImage = 'debian:stable-slim';

/**
 * Extracts encrypted archives, the extractor's GNU tar plus GPG.
 */
const decryptorImage = 'buildpack-deps:stable-curl';

/**
 * Shell function running tar with the given arguments on the archive `/archive/$1`.
 * Encrypted ones are decrypted on the way, with the passphrase from stdin.
 * A wrong passphrase or a tampered archive fails it, after the data was read: callers need `pipefail`.
 */
const archiveReader = [
    'set -o pipefail',
    'archive_tar() {',
    '  case "$1" in',
    '    *.gpg) gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 0 --decrypt "/archive/$1" | tar "${@:2}" -f - ;;',
    '    *) tar "${@:2}" -f "/archive/$1" ;;',
    '  esac',
    '}',
].join('\n');

export default class Restore {
    // `checking`, then `changing` the install, which an interrupt leaves incomplete, then `restarting`.
    static #phase = 'checking';

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
        if (!(await checkDocker(loader)) || !(await acquireLock())) {
            process.exitCode = 1;
            return;
        }

        // exits via `process.exit` to release the lock, attached docker commands get the same Ctrl+C.
        for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
            process.on(name, () => {
                loader.stop();
                if (this.#phase === 'changing') {
                    console.log(
                        chalk.yellow(
                            '⚠️  Restore interrupted, the install is incomplete. Run "abr restore" again.',
                        ),
                    );
                } else if (this.#phase === 'restarting') {
                    console.log(
                        chalk.yellow(
                            `⚠️  Restore complete, but Appwrite may be partly started. Run "docker compose up -d" in ${appwriteDir()}.`,
                        ),
                    );
                }
                process.exit(signalExitCode(name));
            });
        }

        // restores write `appwrite_*` volumes, which compose only uses as project `appwrite`.
        const project = process.env.COMPOSE_PROJECT_NAME;
        if (project && project !== 'appwrite') {
            console.log(
                chalk.red(
                    `❌ COMPOSE_PROJECT_NAME is "${project}", only the default "appwrite" project can be restored. Unset it & try again.`,
                ),
            );
            process.exitCode = 1;
            return;
        }

        // the archive is checked before anything is removed.
        const file = await selectBackup(
            listBackups(),
            'Select a backup file to restore:',
        );
        const passphrase =
            file && isEncrypted(file) ? await readPassphrase() : '';
        if (!file || passphrase === null) {
            process.exitCode = 1;
            return;
        }

        let restored = false;
        try {
            const image = this.#extractor(file);
            loader.start(chalk.blue('Preparing the restore...'));
            await pullImage(image);
            loader.stop();

            const backup = await this.#readArchive(file, passphrase);
            restored =
                Boolean(backup) &&
                (await this.#removeRemnants(backup.volumes, image)) &&
                (await this.#extractArchive(
                    file,
                    backup.volumes,
                    passphrase,
                )) &&
                (!backup.dumped || (await this.#restoreDump(backup.adapter)));
        } catch (error) {
            loader.stop();
            // Ctrl+C at a prompt, handled in index.js.
            if (error.name === 'ExitPromptError') throw error;
            console.log(
                chalk.red('❌ Could not restore:'),
                error.stderr?.trim() || error.message,
            );
        }

        if (!restored) {
            if (this.#phase === 'changing') {
                console.log(
                    chalk.yellow(
                        '⚠️  The install is incomplete. Fix the error above & run "abr restore" again.',
                    ),
                );
            }
            process.exitCode = 1;
            return;
        }
        this.#phase = 'restarting';

        await runCompose(loader, composeSteps.restart);
    }

    /**
     * Reads the whole archive, which also checks its compression & encryption.
     *
     * @param passphrase decrypts the archive, if encrypted.
     * @returns {Promise<{volumes: string[], adapter: object, dumped: boolean}|null>} the volumes in it, its install's database
     * & whether that's a dump, `null` with the reason printed if it's unusable.
     */
    static async #readArchive(file, passphrase) {
        loader.start(chalk.blue('Checking the backup...'));

        const volumes = new Set();
        const files = new Set();
        // database dumps in place of a volume's files, as `<volume>/<dumpFile>`.
        const dumpPaths = Object.values(adapters)
            .filter(({ dumpFile }) => dumpFile)
            .map(({ volume, dumpFile }) => `${volume}/${dumpFile}`);
        const dumps = new Set();
        // volumes with other entries, e.g. a stale dump next to a cold backup's data files.
        const filled = new Set();
        const unexpected = new Set();
        try {
            // with the extractor's tar, which reads it the same way. streamed, archives can hold millions of files.
            // `-P`: offen's names start with `/`, tar would warn about it. its folders have no trailing `/`, so entries are checked by name only.
            const listing = docker(
                this.#archiveScriptArgs(
                    file,
                    [`${path.dirname(file)}:/archive:ro`],
                    'archive_tar "$1" -tzP',
                ),
                { buffer: { stdout: false }, input: passphrase || undefined },
            );
            for await (const name of listing) {
                // empty parts, as in `/backup` or `backup//x`, are dropped by tar too.
                const parts = name.split('/').filter(Boolean);
                const [root, dir, child] = parts;

                // GNU tar skips `..` members & fails, after the install is gone.
                if (root !== 'backup' || parts.includes('..')) {
                    unexpected.add(name);
                } else if (!dir) {
                    continue;
                } else if (dir === 'appwrite') {
                    // bind-mounted to the host & read by compose, ABR only writes install files there, nothing nested.
                    if (parts.length > 3) unexpected.add(name);
                    else if (child) files.add(child);
                } else if (appwriteVolumeName.test(dir)) {
                    // names become `docker run -v` sources & are removed first, so only Appwrite's own volumes.
                    volumes.add(dir);
                    if (!child) continue;
                    const top = `${dir}/${child}`;
                    if (parts.length === 3 && dumpPaths.includes(top)) {
                        dumps.add(top);
                    } else {
                        filled.add(dir);
                    }
                } else {
                    unexpected.add(`backup/${dir}`);
                }
            }
            loader.stop();
        } catch (error) {
            loader.stop();
            if (/bad session key/i.test(error.stderr ?? '')) {
                console.log(
                    chalk.red(
                        `❌ Wrong passphrase for the backup${process.env.ABR_GPG_PASSPHRASE ? ', from ABR_GPG_PASSPHRASE' : ''}.`,
                    ),
                );
                return null;
            }
            console.log(
                chalk.red('❌ The backup is unreadable or incomplete:'),
                error.stderr?.trim() || error.message,
            );
            return null;
        }

        if (unexpected.size) {
            console.log(
                chalk.red(
                    `❌ The backup has unexpected entries: ${[...unexpected]
                        .slice(0, 5)
                        .join(', ')}.`,
                ),
            );
            return null;
        }

        const missing = installFiles.filter((name) => !files.has(name));
        if (missing.length) {
            console.log(
                chalk.red(`❌ The backup is missing ${missing.join(' & ')}.`),
            );
            return null;
        }

        // the backed up install's database: the one with a dump, else with a volume. installs before 1.9 always run MariaDB.
        // a hot backup's database volume holds only its dump.
        const dumped = (volume, dumpFile) =>
            dumps.has(`${volume}/${dumpFile}`) && !filled.has(volume);
        const candidates = Object.values(adapters);
        const adapter =
            candidates.find(({ volume, dumpFile }) =>
                dumped(volume, dumpFile),
            ) ?? candidates.find(({ volume }) => volumes.has(volume));
        if (!adapter) {
            console.log(chalk.red('❌ The backup has no database volume.'));
            return null;
        }

        console.log(chalk.green('✅ Backup checked.'));
        return {
            volumes: [...volumes],
            adapter,
            dumped: dumped(adapter.volume, adapter.dumpFile),
        };
    }

    /**
     * Loads the database dump of a hot backup, after it was extracted. Appwrite's other services stay stopped.
     */
    static async #restoreDump(adapter) {
        loader.start(chalk.blue(`Restoring the ${adapter.name} dump...`));
        try {
            // the restored install's service for the database.
            const { database } = await readCompose();
            await adapter.restoreDump(database.service);
            loader.stop();
        } catch (error) {
            loader.stop();
            console.error(
                chalk.red(`❌ Error restoring the ${adapter.name} dump:`),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        console.log(chalk.green(`✅ ${adapter.name} dump restored.`));
        return true;
    }

    /**
     * Removes the install's containers & volumes, the volumes the backup restores & the `appwrite` folder, once confirmed.
     *
     * @param image already pulled, for root fallbacks.
     * @returns {Promise<boolean>} `false` if declined or failed.
     */
    static async #removeRemnants(volumes, image) {
        let remnants;
        try {
            remnants = await this.#findRemnants(volumes);
        } catch (error) {
            console.error(
                chalk.red('❌ Error checking for Appwrite remnants:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        if (remnants.length === 0) {
            console.log(chalk.green('✅ No Appwrite remnants detected.'));
            return true;
        }

        const table = new Table({
            head: [chalk.blue('Name'), chalk.blue('Type')],
            colWidths: [50, 25],
        });
        remnants.forEach(({ name, type }) =>
            table.push([
                chalk.yellow(name),
                type === 'Volume' && !volumes.includes(name)
                    ? chalk.red('Volume, not in backup')
                    : chalk.green(type),
            ]),
        );
        console.log(chalk.blue('\nDetected Appwrite Remnants:\n'));
        console.log(table.toString());
        console.log('\n');

        const users = remnants.flatMap((remnant) => remnant.users ?? []);
        if (users.length) {
            console.log(
                chalk.red(
                    `❌ Containers outside the install use its volumes, remove them first: ${[...new Set(users)].join(', ')}.`,
                ),
            );
            return false;
        }

        const { shouldDelete } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'shouldDelete',
                message:
                    'Appwrite remnants detected. Do you want to remove them for a clean installation?',
                // a restore replaces the install, so only on an explicit yes.
                default: false,
            },
        ]);
        if (!shouldDelete) {
            console.log(
                chalk.yellow('⚠️  Restoration requires a clean install.'),
            );
            return false;
        }

        const names = (type) =>
            remnants.filter((r) => r.type === type).map((r) => r.name);
        this.#phase = 'changing';
        try {
            const containers = names('Container');
            if (containers.length) {
                // with their anonymous volumes, e.g. of MongoDB's image `VOLUME`s.
                await docker(['rm', '-f', '-v', ...containers]);
            }
            const volumeNames = names('Volume');
            if (volumeNames.length) {
                await docker(['volume', 'rm', '-f', ...volumeNames]);
            }
            // e.g. root-owned, as created by Appwrite's installer.
            if (!(await removePath(appwriteDir(), image))) {
                throw new Error(`could not remove ${appwriteDir()}.`);
            }
        } catch (error) {
            console.error(
                chalk.red('❌ Error removing Appwrite remnants:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        console.log(chalk.green('✅ Appwrite remnants removed.'));
        return true;
    }

    /**
     * The install's containers & volumes by its compose project, plus the volumes the backup restores.
     * Volumes list the `users` outside the install that would block their removal.
     * Cache volumes, which aren't backed up, are kept unless the backup has them.
     */
    static async #findRemnants(volumes) {
        const compose = fs.existsSync(appwriteDir())
            ? await readCompose().catch(() => null)
            : null;
        const project = compose?.project ?? 'appwrite';
        const filter = `label=com.docker.compose.project=${project}`;
        // reused only under the default project, restores bring the install back as `appwrite`.
        // the default caches too, the current compose may predate them.
        const kept = (
            project !== 'appwrite'
                ? []
                : [
                      ...new Set([
                          ...(compose?.excluded ?? []),
                          ...cacheVolumes.map((key) => `${project}_${key}`),
                      ]),
                  ]
        ).filter((volume) => !volumes.includes(volume));

        const list = async (args) =>
            (await docker(args)).stdout.split('\n').filter(Boolean);
        // volumes created by restores have no compose labels, so also the ones the install, backup & older installs name.
        // not every `appwrite_appwrite-*` volume, e.g. a manual copy of one.
        const [containers, projectVolumes, namedVolumes] = await Promise.all([
            list(['ps', '-a', '--filter', filter, '--format', '{{.Names}}']),
            list(['volume', 'ls', '--filter', filter, '--format', '{{.Name}}']),
            existingVolumes([
                ...new Set([
                    ...defaultVolumes,
                    ...(compose?.volumes ?? []),
                    ...volumes,
                ]),
            ]),
        ]);

        // only Appwrite's own: other volumes of the project aren't backed up, removing them would lose them.
        const volumeNames = [
            ...new Set([
                ...projectVolumes.filter(
                    (volume) =>
                        appwriteVolumeName.test(volume) ||
                        volume.startsWith(`${project}_appwrite-`),
                ),
                ...namedVolumes,
            ]),
        ].filter((volume) => !kept.includes(volume));
        const users = await Promise.all(
            volumeNames.map(async (volume) =>
                (
                    await list([
                        'ps',
                        '-a',
                        '--filter',
                        `volume=${volume}`,
                        '--format',
                        '{{.Names}}',
                    ])
                ).filter((name) => !containers.includes(name)),
            ),
        );

        return [
            ...containers.map((name) => ({ name, type: 'Container' })),
            ...volumeNames.map((name, i) => ({
                name,
                type: 'Volume',
                users: users[i],
            })),
            ...(fs.existsSync(appwriteDir())
                ? [{ name: appwriteDir(), type: 'Folder' }]
                : []),
        ];
    }

    /**
     * Extracts the archive straight into the volumes & the `appwrite` folder, as root to keep file owners.
     */
    static async #extractArchive(file, volumes, passphrase) {
        this.#phase = 'changing';
        loader.start(chalk.blue('Restoring volumes...'));

        // the `appwrite` folder is handed to the user running ABR, files in volumes keep their owners.
        // not with rootless docker or userns-remap, where container uids map to other host uids.
        const { stdout: security } = await docker(
            ['info', '--format', '{{json .SecurityOptions}}'],
            { reject: false },
        );
        const remapped = /rootless|userns/.test(security ?? '');
        const owner =
            process.getuid && !remapped
                ? `${process.getuid()}:${process.getgid()}`
                : '';
        try {
            // docker creates the missing `appwrite` folder, as root.
            await docker(
                this.#archiveScriptArgs(
                    file,
                    [
                        ...volumes.map(
                            (volume) => `${volume}:/restore/backup/${volume}`,
                        ),
                        `${appwriteDir()}:/restore/backup/appwrite`,
                        `${path.dirname(file)}:/archive:ro`,
                    ],
                    'archive_tar "$1" -xz -C /restore --numeric-owner && if [ -n "$2" ]; then chown -R "$2" /restore/backup/appwrite; fi',
                    owner,
                ),
                { input: passphrase || undefined },
            );
            loader.stop();
        } catch (error) {
            loader.stop();
            console.error(
                chalk.red('❌ Error during data restoration:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }

        console.log(chalk.green('✅ Restoration completed successfully.'));
        return true;
    }

    /**
     * The image to read the archive with.
     */
    static #extractor(file) {
        return isEncrypted(file) ? decryptorImage : extractorImage;
    }

    /**
     * `docker run` arguments for a `script` reading the archive via `archive_tar "$1" <tar args>`, other `args` follow as `$2`...
     * Encrypted archives read the passphrase from stdin, as env `docker inspect` would show it.
     */
    static #archiveScriptArgs(file, mounts, script, ...args) {
        return helperArgs(
            {
                entrypoint: 'bash',
                image: this.#extractor(file),
                mounts,
                extra: isEncrypted(file) ? ['-i'] : [],
            },
            '-c',
            `${archiveReader}\n${script}`,
            'bash',
            path.basename(file),
            ...args,
        );
    }
}
