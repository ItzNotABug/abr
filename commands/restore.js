import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import Table from 'cli-table3';
import inquirer from 'inquirer';
import loading from 'loading-cli';
import {
    appwriteDir,
    appwriteVolumes,
    checkDocker,
    docker,
    helperArgs,
    installFiles,
    restartAppwriteStack,
    signalExitCode,
} from '../utils/misc.js';
import {
    backupFilePattern,
    backupsDir,
    removePath,
} from '../utils/archives.js';
import { readCompose } from '../utils/compose.js';
import { acquireLock } from '../utils/lock.js';
import { existingVolumes } from '../utils/volumes.js';

const loader = loading('');

/**
 * Extracts archives. GNU tar, busybox's ignores the PAX headers of files over 8 GB.
 */
const extractorImage = 'debian:stable-slim';

/**
 * MariaDB's volume in supported installs, a backup without it can't be restored.
 */
const mariadbVolume = 'appwrite_appwrite-mariadb';

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

        // the archive is checked before anything is removed.
        const file = await this.#selectBackup();
        const volumes =
            file &&
            (await this.#pullExtractor()) &&
            (await this.#readArchive(file));
        if (
            !volumes ||
            !(await this.#removeRemnants(volumes)) ||
            !(await this.#extractArchive(file, volumes))
        ) {
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
     * Select a backup from a list of available backups, if any.
     */
    static async #selectBackup() {
        if (!fs.existsSync(backupsDir())) {
            console.log(chalk.red('❌ No backups directory found.'));
            return null;
        }

        const files = fs
            .readdirSync(backupsDir())
            .filter(
                (file) =>
                    file.startsWith('backup-') && file.endsWith('.tar.gz'),
            );

        if (files.length === 0) {
            console.log(chalk.red('❌ No backup files found.'));
            return null;
        }

        const backups = files.map((file) => {
            const dateMatch = file.match(backupFilePattern);
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

        return path.join(backupsDir(), selectedBackup[0]);
    }

    /**
     * Reads the whole archive, which also checks its compression.
     *
     * @returns {Promise<string[]|null>} the volumes in it, `null` with the reason printed if it's unusable.
     */
    static async #readArchive(file) {
        loader.start(chalk.blue('Checking the backup...'));

        const volumes = new Set();
        const appwriteFiles = new Set();
        const unexpected = new Set();
        // names become `docker run -v` sources & are removed first, so only the supported project's volumes.
        const volumeName = /^appwrite_appwrite-[a-z0-9-]+$/;
        // GNU tar's verbose listing: type & mode, owner, size, date, time, then the C-quoted name.
        // numeric owners, so a crafted user name can't look like the quoted name.
        const entry =
            /^(\S)\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+"((?:[^"\\]|\\.)*)"(?: (?:->|link to) "(?:[^"\\]|\\.)*")?$/;
        try {
            // with the extractor's tar, which reads it the same way. streamed, archives can hold millions of files.
            const listing = docker(
                helperArgs(
                    {
                        entrypoint: 'tar',
                        image: extractorImage,
                        mounts: [`${path.dirname(file)}:/archive:ro`],
                        // escaped bytes for non-ASCII names, whatever the image's locale.
                        env: ['LANG=C'],
                    },
                    '-tvzPf',
                    `/archive/${path.basename(file)}`,
                    '--quoting-style=c',
                    '--numeric-owner',
                ),
                { buffer: { stdout: false } },
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
                } else if (volumeName.test(dir)) {
                    volumes.add(dir);
                } else {
                    unexpected.add(`backup/${dir}`);
                }
            }
            loader.stop();
        } catch (error) {
            loader.stop();
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
     * Pulls the extractor, before anything is removed.
     */
    static async #pullExtractor() {
        loader.start(chalk.blue('Preparing the restore...'));
        try {
            const { failed } = await docker(
                ['image', 'inspect', extractorImage],
                { reject: false },
            );
            if (failed) await docker(['pull', extractorImage]);
            loader.stop();
            return true;
        } catch (error) {
            loader.stop();
            console.log(
                chalk.red(`❌ Could not pull ${extractorImage}:`),
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
                default: true,
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
     */
    static async #findRemnants(volumes) {
        const project = fs.existsSync(appwriteDir())
            ? ((await readCompose().catch(() => null))?.project ?? 'appwrite')
            : 'appwrite';
        const filter = `label=com.docker.compose.project=${project}`;

        const list = async (args) =>
            (await docker(args)).stdout.split('\n').filter(Boolean);
        // volumes created by restores have no compose labels, so also by name.
        const [containers, projectVolumes, namedVolumes] = await Promise.all([
            list(['ps', '-a', '--filter', filter, '--format', '{{.Names}}']),
            list(['volume', 'ls', '--filter', filter, '--format', '{{.Name}}']),
            existingVolumes([...new Set([...appwriteVolumes, ...volumes])]),
        ]);

        const volumeNames = [...new Set([...projectVolumes, ...namedVolumes])];
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
    static async #extractArchive(file, volumes) {
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
                helperArgs(
                    {
                        entrypoint: 'sh',
                        image: extractorImage,
                        mounts: [
                            ...volumes.map(
                                (volume) =>
                                    `${volume}:/restore/backup/${volume}`,
                            ),
                            `${appwriteDir()}:/restore/backup/appwrite`,
                            `${path.dirname(file)}:/archive:ro`,
                        ],
                    },
                    '-c',
                    'tar -xzf "/archive/$1" -C /restore --numeric-owner && if [ -n "$2" ]; then chown -R "$2" /restore/backup/appwrite; fi',
                    'sh',
                    path.basename(file),
                    owner,
                ),
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
