import chalk from 'chalk';
import { setTimeout as wait } from 'node:timers/promises';
import { abrLabel, docker, dockerSync, sleepSync } from '../misc.js';
import * as mariadb from './mariadb.js';
import * as mongodb from './mongodb.js';

/**
 * A database's backup & restore logic, one module per database.
 *
 * @typedef {object} Adapter
 * @property {string} name e.g. `MariaDB`.
 * @property {string} volume its data volume in supported installs.
 * @property {RegExp} image matches its compose image.
 * @property {string} dataDir its data folder in the container.
 * @property {string[]} skipped files in the volume that snapshots skip.
 * @property {string} [dumpFile] the dump hot backups archive in place of the volume's files, if any.
 * @property {(database: {container: string, image: string, env: string[]}, snapshot: string, signal?: AbortSignal) => Promise<void>} snapshot
 * snapshots the running database into the `snapshot` volume.
 * @property {(service: string) => Promise<void>} [restoreDump] loads an extracted dump, for adapters with a `dumpFile`.
 */

/**
 * The database's compose service, from {@link readCompose}.
 *
 * @typedef {{adapter: Adapter|null, service?: string, container?: string, volume?: string, files: string[]}} Database
 */

/**
 * The database container's state, from {@link inspectDatabase}.
 *
 * @typedef {{status: string, image: string, env: string[]}} ContainerState
 */

/**
 * Supported databases by `_APP_DB_ADAPTER`, each with its `name`, `volume`, compose service `image`, `dataDir`, `skipped` files & `snapshot`.
 * MongoDB's snapshot is a dump, restored via its `dumpFile` & `restoreDump`.
 *
 * @type {Record<string, Adapter>}
 */
export const adapters = { mariadb, mongodb };

/**
 * Returns the database container's `status`, `image` id & `env`, or `null` if it can't be inspected, e.g. after `compose down`.
 *
 * @param {string} container the database container's name.
 * @returns {Promise<ContainerState|null>}
 */
export async function inspectDatabase(container) {
    const { failed, stdout } = await docker(
        ['container', 'inspect', container],
        { reject: false },
    );
    if (failed) return null;

    const [{ State, Image, Config }] = JSON.parse(stdout);
    return { status: State.Status, image: Image, env: Config.Env ?? [] };
}

/**
 * Takes a consistent snapshot of the running database via its adapter. The caller removes the snapshot.
 *
 * @param {Loader} loader shows the progress.
 * @param {Database & ContainerState} database the compose `adapter`, `container` & `volume`, with {@link inspectDatabase}'s state.
 * @param {string} snapshot the volume to snapshot into, also the sidecar's name.
 * @param {AbortSignal} signal aborts the snapshot.
 * @returns {Promise<boolean>} `true` if the snapshot is ready, `false` if it failed or `signal` aborted.
 */
export async function snapshotDatabase(loader, database, snapshot, signal) {
    const { name } = database.adapter;
    loader.start(chalk.blue(`Creating ${name} snapshot...`));

    try {
        await docker(
            ['volume', 'create', '--label', `${abrLabel}=snapshot`, snapshot],
            {
                cancelSignal: signal,
            },
        );
        await database.adapter.snapshot(database, snapshot, signal);
    } catch (error) {
        loader.stop();
        if (signal.aborted) return false;

        console.log(
            chalk.red(`❌ Error creating ${name} snapshot:`),
            // execa's messages include the whole command.
            error.stderr?.trim() ||
                (error.exitCode === undefined
                    ? error.message
                    : `exited with code ${error.exitCode}`),
        );
        console.log(chalk.yellow('⚠️  Try a semi-hot or cold backup instead.'));
        return false;
    }

    loader.stop();
    console.log(chalk.green(`✅ ${name} snapshot created.`));
    return true;
}

/**
 * Removes the snapshot container & volume, warns if the volume is left behind.
 *
 * Also stops the given `containers`, e.g. an archive container still using the volume.
 * `-v` removes their anonymous volumes too, e.g. of the database image's `VOLUME`s.
 *
 * @param {string} snapshot the snapshot's container & volume name.
 * @param {...string} containers more containers to stop.
 */
export async function removeSnapshot(snapshot, ...containers) {
    await docker(['rm', '-f', '-v', snapshot, ...containers], {
        reject: false,
    });

    // stays in use briefly while an interrupted sidecar is torn down.
    for (let attempt = 0; attempt < 10; attempt++) {
        const { exitCode } = await docker(['volume', 'rm', '-f', snapshot], {
            reject: false,
        });
        if (exitCode === 0) return;
        await wait(500);
    }

    warnSnapshotLeft(snapshot);
}

/**
 * {@link removeSnapshot} in a forced exit, for up to 5s.
 *
 * @param {string} snapshot the snapshot's container & volume name.
 * @param {...string} containers more containers to stop.
 */
export function removeSnapshotSync(snapshot, ...containers) {
    // stays in use briefly while an interrupted sidecar is torn down, or starts late.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        dockerSync(['rm', '-f', '-v', snapshot, ...containers]);
        if (!dockerSync(['volume', 'rm', '-f', snapshot]).failed) return;
        sleepSync(500);
    }
    warnSnapshotLeft(snapshot);
}

/**
 * Warns that the snapshot's volume stayed behind.
 *
 * @param {string} snapshot the snapshot's volume.
 */
function warnSnapshotLeft(snapshot) {
    process.exitCode ||= 1;
    console.log(
        chalk.yellow(
            `⚠️  Could not remove the "${snapshot}" volume, it holds a full copy of the database. Remove it via "docker volume rm ${snapshot}".`,
        ),
    );
}

/**
 * Warns about snapshots left by killed runs. Not removed, they may belong to a running backup.
 */
export async function warnLeftoverSnapshots() {
    const { stdout } = await docker(
        ['volume', 'ls', '-q', '--filter', `label=${abrLabel}=snapshot`],
        { reject: false },
    );
    const leftovers = stdout?.split('\n').filter(Boolean) ?? [];
    if (leftovers.length === 0) return;

    console.log(
        chalk.yellow(
            `⚠️  Found database snapshots from interrupted backups, they hold full database copies. If no other backup is running, remove them via "docker volume rm ${leftovers.join(' ')}".`,
        ),
    );
}
