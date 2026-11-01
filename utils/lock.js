import { randomBytes } from 'crypto';
import * as fs from 'fs';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';

/**
 * Takes the lock against concurrent ABR runs on this Docker host, released on exit.
 * Host-wide, as supported installations share the same container & volume names.
 *
 * @returns {boolean} `false`, with the reason printed, if another run holds it.
 */
export function acquireLock() {
    // not in the installation's directory, it may be root-owned while docker access is enough for backups.
    // `/tmp` over `os.tmpdir()`, which differs per user on macOS & so between `sudo` & normal runs.
    const dir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const file = path.join(dir, 'abr.lock');
    const breaker = `${file}.break`;

    try {
        if (create(file)) return hold(file);

        // gone if its run just finished.
        const content = readLock(file);
        if (content === null) {
            if (create(file)) return hold(file);
        } else {
            // locks are written whole, so a missing pid is an unreadable lock, treated as held.
            // this run's own pid is a killed run's lock, pids restart from 1 in containers.
            const pid = Number(content);
            if (!pid || (pid !== process.pid && isRunning(pid))) {
                console.error(
                    chalk.red(
                        `❌ Another ABR run (pid ${pid || 'unknown'}) is in progress. If not, remove "${file}".`,
                    ),
                );
                return false;
            }

            // a killed run's lock. replaced by one run at a time, so a fresh lock is never removed.
            if (create(breaker)) {
                try {
                    if (Number(readLock(file)) === pid) {
                        fs.rmSync(file, { force: true });
                    }
                    if (create(file)) return hold(file);
                } finally {
                    fs.rmSync(breaker, { force: true });
                }
            }
        }
    } catch (error) {
        console.error(
            chalk.red(`❌ Could not take the lock "${file}":`),
            `${error.message}. If no other run is in progress, remove it, e.g. via sudo.`,
        );
        return false;
    }

    console.error(
        chalk.red(
            `❌ Another ABR run is starting. If not, remove "${file}" & "${breaker}".`,
        ),
    );
    return false;
}

/**
 * Creates the file with this run's pid, `false` if it exists.
 * Linked from a full temp file, so it never exists without the pid.
 */
function create(file) {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temp, String(process.pid));
    try {
        fs.linkSync(temp, file);
        return true;
    } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

function hold(file) {
    process.on('exit', () => {
        try {
            if (readLock(file) === String(process.pid)) fs.rmSync(file);
        } catch {
            // left for the next run's stale check.
        }
    });
    return true;
}

/**
 * The lock's content, `null` if it doesn't exist, empty if unreadable.
 */
function readLock(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
        return error.code === 'ENOENT' ? null : '';
    }
}

function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // exists, but owned by another user, e.g. a `sudo` run.
        return error.code === 'EPERM';
    }
}
