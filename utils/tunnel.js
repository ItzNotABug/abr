import * as fs from 'fs';
import { bin, install, Tunnel } from 'cloudflared';

/**
 * Cloudflare drops support for cloudflared releases after about a year, so older binaries are replaced.
 */
const maxBinaryAge = 180 * 24 * 60 * 60 * 1000;

/**
 * Installs the cloudflared binary if it's missing or old, the npm package installs it on `npm install` otherwise.
 */
export async function prepareCloudflared() {
    const stale =
        !fs.existsSync(bin) ||
        Date.now() - fs.statSync(bin).mtimeMs > maxBinaryAge;
    if (stale) await install(bin);
}

/**
 * Starts a Cloudflare Quick Tunnel to `http://127.0.0.1:<port>`, which needs no account or domain.
 *
 * @returns {{url: Promise<string>, exited: Promise<void>, done: boolean, stop: () => void}}
 * `url` resolves once Cloudflare is connected, rejects if the tunnel exits first or takes over a minute.
 */
export function startTunnel(port) {
    const cloudflared = Tunnel.quick(`http://127.0.0.1:${port}`, {
        '--no-autoupdate': true,
        // TCP, QUIC's UDP is often blocked by firewalls.
        '--protocol': 'http2',
    });

    const tunnel = { done: false, stop: () => cloudflared.stop() };
    // a child process outlives ABR otherwise, keeping the link up.
    process.once('exit', tunnel.stop);
    tunnel.exited = new Promise((resolve) =>
        cloudflared.once('exit', () => {
            tunnel.done = true;
            process.off('exit', tunnel.stop);
            resolve();
        }),
    );

    // the URL is printed before Cloudflare accepts connections for it.
    const output = [];
    cloudflared.on('stderr', (line) => output.push(line));
    tunnel.url = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cloudflared.stop();
            reject(new Error('the tunnel took too long to start.'));
        }, 60_000);
        let url;
        cloudflared.once('url', (value) => (url = value));
        cloudflared.once('connected', () => {
            clearTimeout(timeout);
            resolve(url);
        });
        tunnel.exited.then(() => {
            clearTimeout(timeout);
            reject(
                new Error(
                    `the tunnel exited.\n${output.slice(-5).join('\n').trim()}`,
                ),
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
    await tunnel.exited;
}
