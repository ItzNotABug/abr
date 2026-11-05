import { execa } from 'execa';

/**
 * The cloudflared package, an optional dependency: loaded on first share, so backups & restores work without it.
 */
let cloudflared;

/**
 * Loads the cloudflared package & installs its binary if missing, e.g. installed with scripts disabled.
 * The package fetches the latest binary on install, so updating ABR updates cloudflared.
 */
export async function prepareCloudflared() {
    try {
        cloudflared ??= await import('cloudflared');
    } catch {
        throw new Error(
            'the cloudflared package is missing, reinstall ABR. It may not support this platform.',
        );
    }
    // also when broken, e.g. an install cut off midway.
    const { failed } = await execa(cloudflared.bin, ['--version'], {
        reject: false,
    });
    if (!failed) return;
    await cloudflared.install(cloudflared.bin);
    const installed = await execa(cloudflared.bin, ['--version'], {
        reject: false,
    });
    if (installed.failed) {
        throw new Error('the cloudflared install failed, try again.');
    }
}

/**
 * Starts a Cloudflare Quick Tunnel to `http://127.0.0.1:<port>`, which needs no account or domain.
 * Only after {@link prepareCloudflared}.
 *
 * @returns {{url: Promise<string>, exited: Promise<void>, stop: () => void, kill: () => void}}
 * `url` resolves once Cloudflare is connected, rejects if the tunnel exits first or takes over a minute.
 */
export function startTunnel(port) {
    const quick = cloudflared.Tunnel.quick(`http://127.0.0.1:${port}`, {
        '--no-autoupdate': true,
        // TCP, QUIC's UDP is often blocked by firewalls.
        '--protocol': 'http2',
    });

    const output = [];
    const tunnel = {
        stop: () => quick.stop(),
        kill: () => quick.process.kill('SIGKILL'),
    };
    // a child process outlives ABR otherwise, keeping the link up.
    process.once('exit', tunnel.stop);
    // a failed start, e.g. a broken binary, may emit `error` without `exit`.
    tunnel.exited = new Promise((resolve) => {
        const exited = () => {
            process.off('exit', tunnel.stop);
            resolve();
        };
        quick.once('exit', exited);
        quick.on('error', (error) => {
            output.push(error.message);
            // only a failed start ends it, other errors leave cloudflared running.
            if (!quick.process.pid) exited();
        });
    });

    // the last lines, to explain a failure.
    quick.on('stderr', (line) => {
        output.push(line);
        output.splice(0, output.length - 5);
    });
    tunnel.url = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            quick.stop();
            reject(new Error('the tunnel took too long to start.'));
        }, 60_000);
        // the URL is printed before Cloudflare accepts connections for it, both may come in any order.
        let url;
        let connected = false;
        const settle = () => {
            if (!url || !connected) return;
            clearTimeout(timeout);
            resolve(url);
        };
        quick.once('url', (value) => {
            url = value;
            settle();
        });
        quick.once('connected', () => {
            connected = true;
            settle();
        });
        tunnel.exited.then(() => {
            clearTimeout(timeout);
            reject(
                new Error(`the tunnel exited.\n${output.join('\n').trim()}`),
            );
        });
    });
    // may reject after the caller stopped waiting, e.g. on Ctrl+C.
    tunnel.url.catch(() => {});
    return tunnel;
}

/**
 * Stops the tunnel & waits for it to exit.
 */
export async function stopTunnel(tunnel) {
    tunnel.stop();
    // killed if it doesn't finish on its own, e.g. stuck in its shutdown.
    const timeout = setTimeout(() => tunnel.kill(), 5000);
    await tunnel.exited;
    clearTimeout(timeout);
}
