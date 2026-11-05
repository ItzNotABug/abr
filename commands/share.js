import * as fs from 'fs';
import chalk from 'chalk';
import * as path from 'path';
import loading from 'loading-cli';
import {
    checkDocker,
    handleInterrupts,
    helperImage,
    pullImages,
    signalExitCode,
    sleep,
} from '../utils/misc.js';
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
    reachesLocalhost,
    removeLeftoverTunnels,
    startTunnel,
    stopTunnel,
    stopTunnelSync,
    tunnelImage,
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

        if (!(await checkDocker(loader))) {
            process.exitCode = 1;
            return;
        }

        // no lock: backups & restores never change existing archives.
        const file = await this.#selectEncryptedBackup();
        const prepared = file && (await this.#prepare(file));
        if (!prepared) {
            process.exitCode = 1;
            return;
        }

        const { token, probe, password, credentials } = newCredentials();
        const share = {
            file,
            name: path.basename(file),
            ...prepared,
            token,
            probe,
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
     * Pulls the images & hashes the file.
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
                stopOnFailure(
                    Promise.all([
                        removeLeftoverTunnels(),
                        pullImages([helperImage], controller.signal),
                        // Cloudflare drops support for old cloudflared releases.
                        pullImages([tunnelImage], controller.signal, {
                            refresh: true,
                        }),
                    ]),
                ),
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
     * @param lifetime of the link, from when it works.
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
                if (tunnel) stopTunnelSync(tunnel);
                process.exit(signalExitCode(name));
            }
            interrupted = name;
            stop(name);
        });

        try {
            server = await startServer(share, (message) => log(share, message));

            loader.start(chalk.blue('Starting the tunnel...'));
            const { port } = server.address();
            if (
                !(await reachesLocalhost(
                    `http://127.0.0.1:${port}/${share.probe}`,
                ))
            ) {
                throw new Error(
                    "containers in the host's network can't reach ABR, e.g. with rootless Docker or Docker Desktop. Sharing needs host networking.",
                );
            }

            // trycloudflare's API times out at times, a new tunnel usually gets through.
            const attempts = 5;
            let url = null;
            for (
                let attempt = 1;
                attempt <= attempts && !interrupted;
                attempt++
            ) {
                if (tunnel) await stopTunnel(tunnel);
                if (attempt > 1) {
                    loader.text = chalk.blue(
                        `Starting the tunnel, attempt ${attempt} of ${attempts}...`,
                    );
                    await sleep(2000 * attempt);
                    if (interrupted) break;
                }
                tunnel = await startTunnel(port);
                tunnel.exited.then(() => (tunnel.done = true));
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

            // a new hostname takes a moment to resolve, so the link is printed once it works, or after a minute:
            // this machine's DNS may cache the name's absence while recipients reach it fine.
            const reachable =
                url &&
                (await reachesPublicly(`${url}/${share.probe}`, stopped));
            // stopped meanwhile, no link to print.
            if (interrupted) url = null;
            // the tunnel died while checking, its link would be dead.
            if (url && tunnel.done) {
                throw new Error('the tunnel stopped.');
            }
            loader.stop();

            if (url) {
                share.url = url;
                share.deadline = Date.now() + lifetime;
                printShare(share, password);
                if (!reachable) {
                    console.log(
                        chalk.yellow(
                            '⚠️  Could not open the link from here yet, it usually works within a minute.',
                        ),
                    );
                }
                // the tunnel ending early stops the share too.
                tunnel.exited.then(() => stop('tunnel'));
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
            if (tunnel) await stopTunnel(tunnel);
            if (server) stopServer(server);
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
    process.stdout.write(
        `\r\x1b[K${chalk.blue(`${text} Press Ctrl+C to stop.`)}`,
    );
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

/**
 * Whether the URL answers through the tunnel within a minute, `false` if the share stopped meanwhile.
 */
async function reachesPublicly(url, stopped) {
    let done = false;
    stopped.then(() => (done = true));
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
        if (done) return false;
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(5000),
            });
            // read, an unread body keeps its connection.
            await response.body?.cancel();
            if (response.ok) return true;
        } catch {
            // not resolvable or reachable yet.
        }
        await sleep(2000);
    }
    return false;
}
