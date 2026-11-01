import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
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
 * Returns an unused path for a new backup archive.
 */
export function newBackupFile() {
    const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replaceAll(':', '-');
    const name = (suffix) =>
        path.join(backupsDir(), `backup-${timestamp}${suffix}.tar.gz`);
    const taken = (file) =>
        fs.existsSync(file) || fs.existsSync(partialFile(file));

    let file = name('');
    for (let i = 1; taken(file); i++) file = name(`-${i}`);
    return file;
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
 * Renames a file, falls back to root via a container as archives & install files may be owned by root.
 */
export async function movePath(from, to) {
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
        await docker(
            rootCommand(from, 'mv', path.basename(from), path.basename(to)),
        );
    }
}

/**
 * Removes a file or folder, if any. Falls back to root like {@link movePath}.
 *
 * @returns {Promise<boolean>} `false` if it could not be removed.
 */
export async function removePath(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
        return true;
    } catch {
        const { failed } = await docker(
            rootCommand(target, 'rm', '-rf', path.basename(target)),
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
        dockerSync(rootCommand(target, 'rm', '-rf', path.basename(target)), {
            reject: false,
        });
    }
}

/**
 * `docker run` arguments to run `command` as root in the target's directory.
 */
function rootCommand(target, command, ...args) {
    return helperArgs(
        {
            entrypoint: command,
            mounts: [`${path.dirname(target)}:/target`],
            workdir: '/target',
        },
        ...args,
    );
}
