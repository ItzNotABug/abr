import * as fs from 'fs';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';

/**
 * Takes the lock against concurrent ABR runs on this Docker host, released on exit.
 * Host-wide, as supported installs share the same container & volume names.
 *
 * @returns {boolean} `false`, with the reason printed, if another run holds it.
 */
export function acquireLock() {
    // not in the install's directory, it may be root-owned while docker access is enough for backups.
    // `/tmp` over `os.tmpdir()`, which differs per user on macOS & so between `sudo` & normal runs.
    const dir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const file = path.join(dir, 'abr.lock');
    const breaker = `${file}.break`;

    try {
        if (create(file)) return hold(file);

        // gone if its run just finished.
        const content = readLock(file);
        if (content === null && create(file)) return hold(file);

        // empty while another run is still writing it, unless that was long ago.
        // this run's own pid is a killed run's lock, pids restart from 1 in containers.
        const pid = Number(content);
        const held = pid
            ? pid !== process.pid && isRunning(pid)
            : !isStale(file);
        if (held) {
            console.error(
                chalk.red(
                    `❌ Another ABR run (pid ${pid || 'unknown'}) is in progress. If not, remove "${file}".`,
                ),
            );
            return false;
        }

        // a killed run's lock. replaced by one run at a time, so a fresh lock is never removed.
        if (isStale(breaker)) fs.rmSync(breaker, { force: true });
        if (create(breaker)) {
            try {
                if (Number(readLock(file)) === pid) fs.rmSync(file);
                if (create(file)) return hold(file);
            } finally {
                fs.rmSync(breaker, { force: true });
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
 */
function create(file) {
    try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        return true;
    } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
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

/**
 * Whether the file was last written over 10s ago, longer than any run takes to write its pid.
 */
function isStale(file) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs > 10_000;
    } catch {
        return false;
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
