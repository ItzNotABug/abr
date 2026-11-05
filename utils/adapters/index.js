import chalk from 'chalk';
import { abrLabel, docker, dockerSync, sleep, sleepSync } from '../misc.js';
import * as mariadb from './mariadb.js';
import * as mongodb from './mongodb.js';

/**
 * Supported databases by `_APP_DB_ADAPTER`, each with its `name`, `volume`, compose service `image`, `dataDir`, `skipped` files & `snapshot`.
 * MongoDB's snapshot is a dump, restored via its `dumpFile` & `restoreDump`.
 */
export const adapters = { mariadb, mongodb };

/**
 * Returns the database container's `status`, `image` id & `env`, or `null` if it can't be inspected, e.g. after `compose down`.
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
 * Returns the snapshot container & volume name for a backup.
 */
export function snapshotName(id) {
    return `abr-db-snapshot-${id}`;
}

/**
 * Takes a consistent snapshot of the running database via its adapter. The caller removes the snapshot.
 *
 * @param database the compose `adapter`, `container` & `volume`, with {@link inspectDatabase}'s state.
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
        await sleep(500);
    }

    warnSnapshotLeft(snapshot);
}

/**
 * Removes the snapshot's volume in a forced exit, after its containers.
 */
export function removeSnapshotVolumeSync(snapshot) {
    // stays in use briefly while an interrupted sidecar is torn down.
    for (let attempt = 0; attempt < 10; attempt++) {
        if (!dockerSync(['volume', 'rm', '-f', snapshot]).failed) return;
        sleepSync(500);
    }
    warnSnapshotLeft(snapshot);
}

/**
 * Warns that the snapshot's volume stayed behind.
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
