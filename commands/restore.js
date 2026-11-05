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
    docker,
    helperArgs,
    installFiles,
    mariadbVolume,
    pullImages,
    restartAppwriteStack,
    signalExitCode,
} from '../utils/misc.js';
import {
    isEncrypted,
    listBackups,
    readPassphrase,
    removePath,
    selectBackup,
} from '../utils/archives.js';
import { cacheVolumes, readCompose } from '../utils/compose.js';
import { existingVolumes } from '../utils/volumes.js';
import { acquireLock } from '../utils/lock.js';

const loader = loading('');

/**
 * Volume names of default Appwrite installs, past & present, to also find unlabelled volumes of earlier restores.
 */
const defaultVolumes = [
    'builds',
    'cache',
    'certificates',
    'config',
    'executor',
    'functions',
    'imports',
    'mariadb',
    'redis',
    'sites',
    'uploads',
].map((name) => `appwrite_appwrite-${name}`);

/**
 * Extracts archives. GNU tar, busybox's ignores the PAX headers of files over 8 GB.
 */
const extractorImage = 'debian:stable-slim';

/**
 * Extracts encrypted archives, the extractor's GNU tar plus GPG.
 */
const decryptorImage = 'buildpack-deps:stable-curl';

/**
 * Shell function writing the archive `/archive/$1` to stdout, decrypted if encrypted, with the passphrase from stdin.
 * A wrong passphrase or a tampered archive fails it, after the data was read: callers need `pipefail`.
 */
const archiveReader = [
    'set -o pipefail',
    'archive() {',
    '  case "$1" in',
    '    *.gpg) gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback --passphrase-fd 0 --decrypt "/archive/$1" ;;',
    '    *) cat "/archive/$1" ;;',
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
            const volumes =
                (await this.#pullImages(file)) &&
                (await this.#readArchive(file, passphrase));
            restored =
                Boolean(volumes) &&
                (await this.#removeRemnants(volumes)) &&
                (await this.#extractArchive(file, volumes, passphrase));
        } catch (error) {
            // Ctrl+C at a prompt, handled in index.js.
            if (error.name === 'ExitPromptError') throw error;
            console.log(chalk.red('❌ Could not restore:'), error.message);
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

        await restartAppwriteStack(loader);
    }

    /**
     * Reads the whole archive, which also checks its compression & encryption.
     *
     * @param passphrase decrypts the archive, if encrypted.
     * @returns {Promise<string[]|null>} the volumes in it, `null` with the reason printed if it's unusable.
     */
    static async #readArchive(file, passphrase) {
        loader.start(chalk.blue('Checking the backup...'));

        const volumes = new Set();
        const appwriteFiles = new Set();
        const unexpected = new Set();
        // names become `docker run -v` sources & are removed first, so only Appwrite's own volumes.
        // GNU tar's verbose listing: type & mode, owner, size, date, time, then the C-quoted name.
        // numeric owners, so a crafted user name can't look like the quoted name.
        const entry =
            /^(\S)\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+"((?:[^"\\]|\\.)*)"(?: (?:->|link to) "(?:[^"\\]|\\.)*")?$/;
        try {
            // with the extractor's tar, which reads it the same way. streamed, archives can hold millions of files.
            const listing = docker(
                this.#archiveScriptArgs(
                    file,
                    [`${path.dirname(file)}:/archive:ro`],
                    'archive "$1" | tar -tvzP --quoting-style=c --numeric-owner -f -',
                ),
                { buffer: { stdout: false }, input: passphrase || undefined },
            );
            for await (const line of listing) {
                const [, type, quoted] = line.match(entry) ?? [];
                const name = quoted === undefined ? '' : unquote(quoted);
                // empty parts, as in `backup//x`, are dropped by tar too.
                const parts = name.split('/').filter(Boolean);
                const [root, dir] = parts;

                // GNU tar skips `..` members & fails, after the install is gone.
                // no hard links, they can fail across volume mounts, nor devices. ABR's archives have neither.
                if (
                    !['d', '-', 'l', 'p'].includes(type) ||
                    parts.includes('..')
                ) {
                    unexpected.add(name || line);
                } else if (root !== 'backup') {
                    unexpected.add(name || line);
                } else if (parts.length <= 2 && type !== 'd') {
                    // `backup`, a volume & `appwrite` can only be folders.
                    unexpected.add(name);
                } else if (!dir) {
                    continue;
                } else if (dir === 'appwrite') {
                    // bind-mounted to the host & read by compose, ABR only writes the two files there.
                    if (parts.length === 2) continue;
                    if (
                        type === '-' &&
                        parts.length === 3 &&
                        installFiles.includes(parts[2])
                    ) {
                        appwriteFiles.add(parts[2]);
                    } else {
                        unexpected.add(name);
                    }
                } else if (appwriteVolumeName.test(dir)) {
                    volumes.add(dir);
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
                    // quoted, names may hold control characters.
                    `❌ The backup has unexpected entries: ${[...unexpected]
                        .slice(0, 5)
                        .map((name) => JSON.stringify(name))
                        .join(', ')}.`,
                ),
            );
            return null;
        }

        const missing = [...installFiles, mariadbVolume].filter(
            (name) => !appwriteFiles.has(name) && !volumes.has(name),
        );
        if (missing.length) {
            console.log(
                chalk.red(`❌ The backup is missing ${missing.join(' & ')}.`),
            );
            return null;
        }

        console.log(chalk.green('✅ Backup checked.'));
        return [...volumes];
    }

    /**
     * Pulls the images restoring the archive needs, before anything is removed.
     * Also the plain extractor, for root fallbacks.
     */
    static async #pullImages(file) {
        loader.start(chalk.blue('Preparing the restore...'));
        try {
            await pullImages([
                ...new Set([this.#extractor(file), extractorImage]),
            ]);
            loader.stop();
            return true;
        } catch (error) {
            loader.stop();
            console.log(
                chalk.red('❌ Could not pull the images to restore with:'),
                error.stderr?.trim() || error.message,
            );
            return false;
        }
    }

    /**
     * Removes the install's containers & volumes, the volumes the backup restores & the `appwrite` folder, once confirmed.
     *
     * @returns {Promise<boolean>} `false` if declined or failed.
     */
    static async #removeRemnants(volumes) {
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
                await docker(['rm', '-f', ...containers]);
            }
            const volumeNames = names('Volume');
            if (volumeNames.length) {
                await docker(['volume', 'rm', '-f', ...volumeNames]);
            }
            // e.g. root-owned, as created by Appwrite's installer.
            if (!(await removePath(appwriteDir(), extractorImage))) {
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

        const volumeNames = [
            ...new Set([...projectVolumes, ...namedVolumes]),
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
                    'archive "$1" | tar -xz -f - -C /restore --numeric-owner && if [ -n "$2" ]; then chown -R "$2" /restore/backup/appwrite; fi',
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
     * `docker run` arguments for a `script` reading the archive via `archive "$1"`, other `args` follow as `$2`...
     * Encrypted archives read the passphrase from stdin, as env `docker inspect` would show it.
     */
    static #archiveScriptArgs(file, mounts, script, ...args) {
        return helperArgs(
            {
                entrypoint: 'bash',
                image: this.#extractor(file),
                mounts,
                // escaped bytes for non-ASCII names in listings, whatever the image's locale.
                env: ['LANG=C'],
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

const namedEscapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

/**
 * Decodes a name quoted by GNU tar's `--quoting-style=c`, with octal escapes for non-ASCII bytes.
 */
function unquote(quoted) {
    if (!quoted.includes('\\')) return quoted;

    // escapes become latin1 chars, i.e. single bytes, decoded as utf8 after.
    const bytes = quoted.replace(/\\(?:([0-7]{3})|(.))/g, (_, octal, char) =>
        String.fromCharCode(
            octal
                ? parseInt(octal, 8)
                : (namedEscapes[char] ?? char.charCodeAt(0)),
        ),
    );
    return Buffer.from(bytes, 'latin1').toString('utf8');
}
