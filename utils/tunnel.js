import * as os from 'os';
import * as readline from 'readline';
import { abrLabel, docker, dockerSync, helperArgs, isRunning } from './misc.js';

/**
 * Labels tunnels with the host & pid of their share, to tell the ones of killed shares.
 * Pids of other hosts or containers can't be checked, their tunnels are left alone.
 */
const ownerLabel = `${abrLabel}.owner`;
const owner = `${os.hostname()}:${process.pid}`;

/**
 * Runs Cloudflare Quick Tunnels, which need no account or domain.
 */
export const tunnelImage = 'cloudflare/cloudflared:latest';

/**
 * Starts a quick tunnel to `http://127.0.0.1:<port>`, in the host's network.
 * The container is created before it starts, so {@link stopTunnel} always finds it by name.
 *
 * @returns {Promise<{name: string, subprocess: object, url: Promise<string>, exited: Promise<void>}>}
 * `url` resolves once Cloudflare is connected, rejects if the tunnel exits first or takes over a minute.
 */
export async function startTunnel(port) {
    const name = `abr-share-${Date.now()}`;
    const [, ...args] = helperArgs(
        {
            entrypoint: 'cloudflared',
            image: tunnelImage,
            name,
            role: 'share',
            extra: ['--network', 'host', '--label', `${ownerLabel}=${owner}`],
        },
        'tunnel',
        '--no-autoupdate',
        // TCP, QUIC's UDP is often blocked by firewalls & nested networks.
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${port}`,
    );
    await docker(['create', ...args]);

    // detached, so not stopped by execa on exit. a crash would leave the URL pointing at a port another process may take.
    const onExit = () => stopTunnelSync({ name });
    process.once('exit', onExit);
    const subprocess = docker(['start', '--attach', name], {
        buffer: false,
        stdout: 'ignore',
        reject: false,
    });
    subprocess.finally(() => process.off('exit', onExit));

    const url = waitForUrl(subprocess);
    // may reject after the caller stopped waiting, e.g. on Ctrl+C.
    url.catch(() => {});
    return { name, subprocess, url, exited: subprocess.then(() => {}) };
}

/**
 * Stops the tunnel & waits for its container to be gone.
 */
export async function stopTunnel({ name, subprocess, exited }) {
    await docker(['rm', '-f', name], { reject: false });
    subprocess.kill();
    await exited;
}

/**
 * Whether containers in the host's network, like the tunnel, reach the given local URL.
 * Not the case e.g. with rootless Docker or Docker Desktop without host networking.
 */
export async function reachesLocalhost(url) {
    const { failed, exitCode, stderr } = await docker(
        helperArgs(
            { entrypoint: 'wget', extra: ['--network', 'host'] },
            '-q',
            '-T',
            '5',
            '-O',
            '/dev/null',
            url,
        ),
        { reject: false },
    );
    // busybox wget fails with 1, other codes are docker's or the container's.
    if (failed && exitCode !== 1) {
        throw new Error(
            stderr?.trim() || `docker run exited with ${exitCode}.`,
        );
    }
    return !failed;
}

/**
 * {@link stopTunnel} for a forced exit.
 */
export function stopTunnelSync({ name }) {
    dockerSync(['rm', '-f', name], { reject: false });
}

/**
 * Removes tunnels of killed shares, others belong to running shares.
 */
export async function removeLeftoverTunnels() {
    const { stdout } = await docker([
        'ps',
        '-a',
        '--filter',
        `label=${abrLabel}=share`,
        '--format',
        `{{.Names}} {{.Label "${ownerLabel}"}}`,
    ]);
    const leftovers = stdout
        .split('\n')
        .map((line) => line.split(' '))
        .filter(([name, label = '']) => {
            const [host, pid] = label.split(':');
            // this run's own pid is a killed run's, pids restart from 1 in containers.
            return (
                name &&
                host === os.hostname() &&
                (Number(pid) === process.pid || !isRunning(Number(pid)))
            );
        })
        .map(([name]) => name);
    // a leftover doesn't hinder this share, e.g. one being removed already.
    if (leftovers.length) {
        await docker(['rm', '-f', ...leftovers], { reject: false });
    }
}

/**
 * The tunnel's URL from its log, once it has a connection to Cloudflare.
 */
function waitForUrl(subprocess) {
    // read to the end, a full pipe would block cloudflared.
    const lines = [];
    let url;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('the tunnel took too long to start.')),
            60_000,
        );
        readline
            .createInterface({ input: subprocess.stderr })
            .on('line', (line) => {
                lines.push(line);
                if (lines.length > 10) lines.shift();
                // quick tunnel names are hyphenated words, unlike `api.trycloudflare.com` in errors.
                url ??= line.match(
                    /https:\/\/[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com/,
                )?.[0];
                if (url && /Registered tunnel connection/.test(line)) {
                    clearTimeout(timeout);
                    resolve(url);
                }
            });
        subprocess.then(() => {
            clearTimeout(timeout);
            reject(new Error(`the tunnel exited.\n${lines.join('\n')}`));
        });
    });
}
