import * as net from 'net';
import chalk from 'chalk';

/**
 * Held as a listening socket on this port, the kernel frees it when the process ends, however it ends.
 * Below the ephemeral ranges, so random published & outgoing ports never take it.
 */
const lockPort = 31991;

/**
 * Takes the lock against concurrent ABR runs on this host, released on exit.
 * Host-wide, as supported installations share the same container & volume names.
 *
 * @returns {Promise<boolean>} `false`, with the reason printed, if another run holds it.
 */
export function acquireLock() {
    return new Promise((resolve) => {
        // connections are closed right away, they would keep ABR from exiting.
        const server = net.createServer((socket) => socket.destroy());
        server.once('error', (error) => {
            console.log(
                chalk.red(
                    error.code === 'EADDRINUSE'
                        ? `❌ Another ABR run is in progress (port ${lockPort} on 127.0.0.1 is in use).`
                        : `❌ Could not take the lock on port ${lockPort}: ${error.message}`,
                ),
            );
            resolve(false);
        });
        // `exclusive`: not shared with cluster workers. `unref`: doesn't keep ABR running.
        server.listen(
            { port: lockPort, host: '127.0.0.1', exclusive: true },
            () => {
                server.unref();
                resolve(true);
            },
        );
    });
}
