import * as fs from 'fs';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import inquirer from 'inquirer';
import { pipeline } from 'stream/promises';
import { docker, dockerSync, helperArgs } from './misc.js';

/**
 * Backup archive names start with their UTC time, `backup-YYYY-MM-DDTHH-MM-SS`.
 */
export const backupFilePattern =
    /^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;

export function backupsDir() {
    return path.join(process.cwd(), 'backups');
}

/**
 * Extensions of backup archives, plain & encrypted via GPG.
 */
const extensions = ['.tar.gz', '.tar.gz.gpg'];

export function isEncrypted(file) {
    return file.endsWith('.gpg');
}

/**
 * Returns an unused path for a new backup archive.
 */
export function newBackupFile(encrypted = false) {
    // created by ABR, `docker run -v` would create it as root.
    fs.mkdirSync(backupsDir(), { recursive: true });
    const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replaceAll(':', '-');
    const name = (suffix, extension) =>
        path.join(backupsDir(), `backup-${timestamp}${suffix}${extension}`);
    // a name is taken by either extension, so plain & encrypted backups never share one.
    const taken = (suffix) =>
        extensions.some((extension) => {
            const file = name(suffix, extension);
            return fs.existsSync(file) || fs.existsSync(partialFile(file));
        });

    let suffix = '';
    for (let i = 1; taken(suffix); i++) suffix = `-${i}`;
    return name(suffix, extensions[encrypted ? 1 : 0]);
}

/**
 * The file's SHA-256, in hex.
 */
export async function hashFile(file, signal) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash, { signal });
    return hash.digest('hex');
}

/**
 * Whether the file starts like a passphrase encrypted OpenPGP message, as GPG archives do.
 * A renamed plain archive starts with gzip's header instead.
 */
export function startsAsOpenPGP(file) {
    const header = Buffer.alloc(1);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, header, 0, 1, 0);
    } finally {
        fs.closeSync(fd);
    }
    // a symmetric-key session key packet, in the old or new packet format.
    // only those: restores decrypt with a passphrase, not with a private key.
    return [0x8c, 0x8d, 0x8e, 0x8f, 0xc3].includes(header[0]);
}

/**
 * The backup archives in `backups/`, by name, so oldest first.
 */
export function listBackups() {
    if (!fs.existsSync(backupsDir())) return [];
    return (
        fs
            .readdirSync(backupsDir())
            .filter(
                (file) =>
                    file.startsWith('backup-') &&
                    extensions.some((extension) => file.endsWith(extension)),
            )
            // by name without extensions, `-1` collision suffixes sort before `.` otherwise.
            .sort((a, b) => {
                const base = (file) => file.replace(/\.tar\.gz(\.gpg)?$/, '');
                return base(a).localeCompare(base(b), 'en');
            })
    );
}

/**
 * Asks for one of the given backups.
 *
 * @param files backup names, from {@link listBackups}.
 * @returns {Promise<string|null>} its path, `null` if there are none.
 */
export async function selectBackup(files, message) {
    if (files.length === 0) {
        console.log(chalk.red('❌ No backup files found.'));
        return null;
    }

    // newest first, a single Enter picks the latest backup.
    const backups = [...files].reverse().map((file) => {
        const dateMatch = file.match(backupFilePattern);
        const lock = isEncrypted(file) ? ', encrypted' : '';
        if (!dateMatch) {
            return { name: file, displayDate: `Unknown${lock}` };
        }

        const [, year, month, day, hour, minute] = dateMatch;

        const hourInt = parseInt(hour, 10);
        const period = hourInt >= 12 ? 'PM' : 'AM';
        const formattedHour = ((hourInt + 11) % 12) + 1; // Convert to 12-hour format
        const formattedDate = `${day}/${month}/${year} @ ${formattedHour}:${minute} ${period}`;

        return { name: file, displayDate: `${formattedDate}${lock}` };
    });

    console.log('\n');

    // one choice, a multi-select would quietly use only one of several picks.
    const { selectedBackup } = await inquirer.prompt([
        {
            type: 'select',
            name: 'selectedBackup',
            message,
            choices: backups.map((b) => ({
                name: `${b.name} (${b.displayDate})`,
                value: b.name,
            })),
        },
    ]);

    return path.join(backupsDir(), selectedBackup);
}

/**
 * The passphrase of encrypted backups, from `ABR_GPG_PASSPHRASE` or a prompt.
 * Single line only, GPG reads passphrases up to the first line break.
 *
 * @param confirm asks twice, for new backups.
 * @returns {Promise<string|null>} `null` with the reason printed if the variable is unusable.
 */
export async function readPassphrase(confirm = false) {
    const variable = process.env.ABR_GPG_PASSPHRASE;
    if (variable && /[\r\n]/.test(variable)) {
        console.log(
            chalk.red('❌ ABR_GPG_PASSPHRASE must not contain line breaks.'),
        );
        return null;
    }
    if (variable) return variable;

    const ask = async (message) =>
        (
            await inquirer.prompt([
                {
                    type: 'password',
                    name: 'passphrase',
                    message,
                    mask: '*',
                    validate: (input) =>
                        input.length > 0 || 'The passphrase cannot be empty.',
                },
            ])
        ).passphrase;

    for (;;) {
        const passphrase = await ask('Enter the backup passphrase:');
        if (!confirm || (await ask('Repeat the passphrase:')) === passphrase) {
            return passphrase;
        }
        console.log(chalk.yellow('⚠️  The passphrases do not match.'));
    }
}

/**
 * Where an archive is written until it's complete, not listed by restores.
 */
export function partialFile(file) {
    return path.join(path.dirname(file), `.partial-${path.basename(file)}`);
}

/**
 * Warns about archives left by killed runs, they can be large.
 * Not removed, one may be complete but failed to be renamed.
 */
export function warnPartialArchives() {
    const partials = fs.existsSync(backupsDir())
        ? fs
              .readdirSync(backupsDir())
              .filter((file) => file.startsWith('.partial-'))
        : [];
    if (partials.length === 0) return;

    console.log(
        chalk.yellow(
            `⚠️  Found unfinished archives from interrupted backups in backups/, remove them unless one was reported complete: ${partials.join(', ')}.`,
        ),
    );
}

/**
 * Removes passphrase files left in `backups/` by killed runs, they'd be copied along with the archives.
 * Only call while holding the lock.
 */
export async function removeLeftoverPassphrases() {
    const leftovers = fs.existsSync(backupsDir())
        ? fs
              .readdirSync(backupsDir())
              .filter((name) => name.startsWith('.abr-passphrase-'))
        : [];
    for (const leftover of leftovers) {
        if (!(await removePath(path.join(backupsDir(), leftover)))) {
            console.log(
                chalk.red(
                    `❌ Could not remove "${leftover}" in backups/, it holds a backup passphrase. Remove it.`,
                ),
            );
        }
    }
}

/**
 * Writes the passphrase to a file only this user can read, to mount into containers. As env, `docker inspect` would show it.
 * In `backups/`, which containers reading or writing archives mount at `/archive` already: Docker may not see the temp folder.
 * A temp folder, mounted itself, if `backups/` isn't writable, e.g. root-owned.
 *
 * @returns {{path: string, mount: string|null, remove: () => void}} `path` is the file inside the container, `mount` extra.
 */
export function passphraseFile(passphrase) {
    let dir;
    let mount = null;
    let inside;
    try {
        dir = fs.mkdtempSync(path.join(backupsDir(), '.abr-passphrase-'));
        inside = `/archive/${path.basename(dir)}`;
    } catch {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-passphrase-'));
        mount = `${dir}:/run/abr:ro`;
        inside = '/run/abr';
    }

    const remove = () => fs.rmSync(dir, { recursive: true, force: true });
    // also on a forced exit.
    process.once('exit', remove);
    try {
        fs.writeFileSync(path.join(dir, 'passphrase'), passphrase, {
            mode: 0o600,
        });
    } catch (error) {
        remove();
        throw error;
    }
    return {
        path: `${inside}/passphrase`,
        mount,
        remove: () => {
            process.off('exit', remove);
            remove();
        },
    };
}

/**
 * Renames a file, falls back to root via a container as archives & install files may be owned by root.
 */
export async function movePath(from, to) {
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
        await docker(
            rootCommand(from, ['mv', path.basename(from), path.basename(to)]),
        );
    }
}

/**
 * Removes a file or folder, if any. Falls back to root like {@link movePath}.
 *
 * @param image for the root fallback, e.g. one already pulled.
 * @returns {Promise<boolean>} `false` if it could not be removed.
 */
export async function removePath(target, image) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
        return true;
    } catch {
        const { failed } = await docker(
            rootCommand(target, ['rm', '-rf', path.basename(target)], image),
            { reject: false },
        );
        return !failed;
    }
}

/**
 * {@link removePath} for a forced exit.
 */
export function removePathSync(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch {
        dockerSync(rootCommand(target, ['rm', '-rf', path.basename(target)]), {
            reject: false,
        });
    }
}

/**
 * `docker run` arguments to run a command as root in the target's directory.
 */
function rootCommand(target, [command, ...args], image) {
    return helperArgs(
        {
            entrypoint: command,
            mounts: [`${path.dirname(target)}:/target`],
            workdir: '/target',
            ...(image && { image }),
        },
        ...args,
    );
}
