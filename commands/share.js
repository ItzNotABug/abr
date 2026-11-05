import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import loading from 'loading-cli';
import { setTimeout as wait } from 'timers/promises';
import { handleInterrupts, signalExitCode } from '../utils/misc.js';
import {
    hashFile,
    isEncrypted,
    listBackups,
    selectBackup,
    startsAsOpenPGP,
} from '../utils/archives.js';
import {
    curlCommand,
    newCredentials,
    startServer,
    stopServer,
} from '../utils/share-server.js';
import {
    prepareCloudflared,
    startTunnel,
    stopTunnel,
} from '../utils/tunnel.js';
import { formatSize } from '../utils/volumes.js';

const loader = loading('');

/**
 * The longest a link may live, quick tunnels are meant to be temporary.
 */
const maxLifetime = 24 * 60 * 60 * 1000;

/**
 * How long downloads running at expiry may still take.
 */
const drainLimit = 60 * 60 * 1000;

/**
 * How long a finished download may still be on its way to the client.
 */
const flushTime = 60 * 1000;

export default class Share {
    /**
     * The share command for `yargs` to manage.
     */
    static yargsCommand() {
        return {
            command: 'share',
            description:
                'Shares an encrypted backup via a temporary download link!',
            builder: (yargs) =>
                yargs.option('expires', {
                    type: 'string',
                    default: '15m',
                    description:
                        'How long the link works, e.g. 30m, 1h or 1h30m, up to 24h',
                }),
            handler: async (argv) => await this.#performTask(argv),
        };
    }

    /**
     * Starts task once yargs receives the command.
     */
    static async #performTask({ expires }) {
        const lifetime = parseDuration(expires);
        if (!lifetime) {
            console.log(
                chalk.red(
                    `❌ Invalid expiry "${expires}", use e.g. 30m, 1h or 1h30m, up to 24h.`,
                ),
            );
            process.exitCode = 1;
            return;
        }

        // no Docker needed, nor a lock: backups & restores never change existing archives.
        const file = await this.#selectEncryptedBackup();
        const prepared = file && (await this.#prepare(file));
        if (!prepared) {
            process.exitCode = 1;
            return;
        }

        const { token, password, credentials } = newCredentials();
        const share = {
            file,
            name: path.basename(file),
            ...prepared,
            token,
            credentials,
            deadline: 0,
            url: '',
            active: 0,
            finishedAt: 0,
            expired: false,
            done: false,
        };
        await this.#share(share, password, lifetime);
    }

    /**
     * Asks for an encrypted backup, `null` with the reason printed if there's none.
     * Cloudflare decrypts TLS at its edge, so only encrypted archives leave the host.
     */
    static async #selectEncryptedBackup() {
        const backups = listBackups();
        const encrypted = backups.filter(isEncrypted);
        if (backups.length && !encrypted.length) {
            console.log(
                chalk.red(
                    '❌ Only encrypted backups can be shared, as Cloudflare can read the traffic. Create one via "abr backup --encrypt".',
                ),
            );
            return null;
        }
        if (encrypted.length < backups.length) {
            console.log(
                chalk.yellow(
                    '⚠️  Unencrypted backups are not listed, only encrypted ones can be shared.',
                ),
            );
        }

        const file = await selectBackup(
            encrypted,
            'Select a backup file to share:',
        );
        if (!file) return null;

        try {
            if (startsAsOpenPGP(file)) return file;
            console.log(
                chalk.red(
                    `❌ ${path.basename(file)} is not encrypted, only its name ends in .gpg.`,
                ),
            );
        } catch (error) {
            console.log(
                chalk.red(`❌ Could not read ${path.basename(file)}:`),
                error.message,
            );
        }
        return null;
    }

    /**
     * Prepares cloudflared & hashes the file.
     *
     * @returns {Promise<{sha256: string, size: number}|null>} `null` with the reason printed on failure.
     */
    static async #prepare(file) {
        loader.start(chalk.blue('Preparing the share...'));
        try {
            // either failing stops the other, the process couldn't exit before.
            const controller = new AbortController();
            const stopOnFailure = (promise) =>
                promise.catch((error) => {
                    controller.abort();
                    throw error;
                });
            const [sha256] = await Promise.all([
                stopOnFailure(hashFile(file, controller.signal)),
                stopOnFailure(prepareCloudflared()),
            ]);
            loader.stop();
            return { sha256, size: fs.statSync(file).size };
        } catch (error) {
            loader.stop();
            console.log(
                chalk.red('❌ Could not prepare the share:'),
                error.stderr?.trim() || error.message,
            );
            return null;
        }
    }

    /**
     * Serves the file on localhost, exposed by a quick tunnel, until it expires or is interrupted.
     *
     * @param lifetime of the link, from when the tunnel is up.
     */
    static async #share(share, password, lifetime) {
        let server;
        let tunnel;
        let timer;
        let reason;
        let stop;
        const stopped = new Promise((resolve) => (stop = resolve));

        // a second interrupt exits right away.
        let interrupted = false;
        const release = handleInterrupts((name) => {
            loader.stop();
            if (interrupted) {
                tunnel?.stop();
                process.exit(signalExitCode(name));
            }
            interrupted = name;
            stop(name);
        });

        try {
            server = await startServer(share, (message) => log(share, message));

            loader.start(chalk.blue('Starting the tunnel...'));
            const { port } = server.address();

            // trycloudflare's API times out at times, a new tunnel usually works.
            const attempts = 5;
            let url = null;
            for (let attempt = 1; attempt <= attempts; attempt++) {
                if (attempt > 1) {
                    await stopTunnel(tunnel);
                    loader.text = chalk.blue(
                        `Starting the tunnel, attempt ${attempt} of ${attempts}...`,
                    );
                    // unref'd, to exit at once when stopped meanwhile.
                    await Promise.race([
                        wait(2000 * (attempt - 1), undefined, { ref: false }),
                        stopped,
                    ]);
                }
                if (interrupted) break;

                tunnel = startTunnel(port);
                try {
                    url = await Promise.race([
                        tunnel.url,
                        stopped.then(() => null),
                    ]);
                    break;
                } catch (error) {
                    if (attempt === attempts) throw error;
                }
            }
            loader.stop();

            if (url && !interrupted) {
                share.url = url;
                share.deadline = Date.now() + lifetime;
                printShare(share, password);
                // the tunnel ending early stops the share too.
                // after expiry it may end while downloads finish, which is no failure.
                tunnel.exited.then(() =>
                    stop(share.expired ? 'expired' : 'tunnel'),
                );
                timer = startCountdown(share, () => stop('expired'));
            }
            reason = await stopped;
        } catch (error) {
            loader.stop();
            if (interrupted) {
                reason = interrupted;
            } else {
                console.log(
                    chalk.red('❌ Could not share the backup:'),
                    error.message,
                );
                process.exitCode = 1;
            }
        } finally {
            share.done = true;
            clearInterval(timer);
            clearStatus();
            // the server first, cloudflared waits for open requests otherwise.
            if (server) stopServer(server);
            if (tunnel) await stopTunnel(tunnel);
        }

        // before the release, which stops ignoring write errors of a hung up terminal.
        printStopped(reason);
        release();
    }
}

function printShare(share, password) {
    console.log(
        chalk.green(
            `✅ Sharing ${share.name} (${formatSize(share.size / 1024)}) until ${new Date(share.deadline).toLocaleString()}.`,
        ),
    );
    console.log(
        [
            `   Link:      ${chalk.bold(`${share.url}/${share.token}/`)}`,
            `   User:      ${chalk.bold('abr')}`,
            `   Password:  ${chalk.bold(password)}`,
            `   SHA-256:   ${share.sha256}`,
            `   curl:      ${curlCommand(share)}`,
        ].join('\n'),
    );
    // a new tunnel name takes a while to resolve everywhere.
    console.log(chalk.yellow('⚠️  The link may take a minute to work.'));
    console.log(
        chalk.yellow(
            '⚠️  The password is shown only once. Send it apart from the link, along with the backup passphrase.',
        ),
    );
}

/**
 * @param reason what stopped the share, nothing to print for errors.
 */
function printStopped(reason) {
    if (reason === 'expired') {
        console.log(chalk.green('✅ The link expired, sharing stopped.'));
    } else if (reason === 'tunnel') {
        console.log(
            chalk.red('❌ The tunnel stopped unexpectedly, sharing stopped.'),
        );
        process.exitCode = 1;
    } else if (reason) {
        console.log(chalk.yellow('⚠️  Sharing stopped.'));
        // Ctrl+C is the normal way to stop sharing early.
        if (reason !== 'SIGINT') process.exitCode = signalExitCode(reason);
    }
}

/**
 * Updates the status line every second. At the deadline, new requests are refused
 * & `expire` is called once running downloads finished, or took too long.
 */
function startCountdown(share, expire) {
    status(share);
    return setInterval(() => {
        const now = Date.now();
        // Cloudflare still sends what it buffered after the server is done, a stop would cut it off.
        const busy = share.active || now < share.finishedAt + flushTime;
        if (now >= share.deadline && !share.expired) {
            share.expired = true;
            if (share.active) {
                log(
                    share,
                    chalk.yellow(
                        '⚠️  The link expired, running downloads may finish within the next hour.',
                    ),
                );
            }
        }
        if (share.expired && (!busy || now >= share.deadline + drainLimit)) {
            expire();
        } else {
            status(share);
        }
    }, 1000);
}

/**
 * The live status line, on terminals only.
 */
function status(share) {
    if (!process.stdout.isTTY || !share.url || share.done) return;
    const downloads = `${share.active} download${share.active > 1 ? 's' : ''}`;
    const text = share.expired
        ? '⏳ The link expired, waiting for downloads to finish.'
        : `⏳ Expires in ${formatRemaining(share.deadline - Date.now())}${share.active ? `, ${downloads} running` : ''}.`;
    // within the terminal's width, a wrapped line isn't cleared by `\r`.
    const line = `${text} Press Ctrl+C to stop.`.slice(
        0,
        (process.stdout.columns || 80) - 1,
    );
    process.stdout.write(`\r\x1b[K${chalk.blue(line)}`);
}

function clearStatus() {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
}

/**
 * Prints above the status line.
 */
function log(share, message) {
    // e.g. downloads cut off by the stop, the terminal may be gone.
    if (share.done) return;
    clearStatus();
    console.log(message);
    status(share);
}

/**
 * Milliseconds of a duration like `90s`, `30m` or `1h30m`, `null` if invalid or over the maximum.
 */
function parseDuration(text) {
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(
        String(text ?? ''),
    );
    if (!match) return null;

    const [hours, minutes, seconds] = match.slice(1).map((n) => Number(n ?? 0));
    const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
    return ms > 0 && ms <= maxLifetime ? ms : null;
}

/**
 * Formats remaining milliseconds as `h:mm:ss` or `m:ss`.
 */
function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const pad = (value) => String(value).padStart(2, '0');
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
}
