import chalk from 'chalk';
import {
    abrLabel,
    docker,
    dockerSync,
    helperArgs,
    sleep,
    sleepSync,
} from '../misc.js';
import * as mariadb from './mariadb.js';

/**
 * Supported databases by `_APP_DB_ADAPTER`, each with its `name`, `volume`, compose service `image`, `dataDir` & `snapshot`.
 */
export const adapters = { mariadb };

/**
 * Returns the database container's `status`, `image` id & `env`, or `null` if it doesn't exist.
 *
 * Throws on any other failure, callers must not mistake it for a stopped database.
 */
export async function inspectDatabase(container) {
    const { failed, stdout, stderr } = await docker(
        ['container', 'inspect', container],
        { reject: false },
    );
    if (failed) {
        if (/no such (container|object)/i.test(stderr)) return null;
        throw new Error(stderr?.trim() || 'docker container inspect failed.');
    }

    try {
        const [{ State, Image, Config }] = JSON.parse(stdout);
        return {
            status: State.Status,
            image: Image,
            env: Config.Env ?? [],
        };
    } catch {
        throw new Error('unexpected docker container inspect output.');
    }
}

/**
 * Whether a running or paused container other than the database uses its volume. Throws if unknown.
 */
export async function isVolumeUsedByOthers({ container, volume }) {
    const { failed, stdout, stderr } = await docker(
        ['ps', '--format', '{{.Names}}', '--filter', `volume=${volume}`],
        { reject: false },
    );
    if (failed) throw new Error(stderr?.trim() || 'docker ps failed.');

    return stdout.split('\n').some((name) => name && name !== container);
}

/**
 * Lists the volume's files with sizes & change times, any write changes it. Throws on failure.
 *
 * Stopped databases are copied as is, this tells if one wrote during the copy, e.g. started or unpaused briefly.
 */
export async function listDatabaseFiles({ volume }) {
    const { stdout } = await docker(
        helperArgs(
            {
                entrypoint: 'find',
                mounts: [`${volume}:/data:ro`],
                workdir: '/data',
            },
            '.',
            '-exec',
            'stat',
            '-c',
            '%n %s %y %z',
            '{}',
            '+',
        ),
    );
    // sorted, directory order may differ between runs.
    return stdout.split('\n').sort().join('\n');
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

    const fail = (message, suggestOtherTypes = true) => {
        loader.stop();
        if (signal.aborted) return false;

        console.log(chalk.red(`❌ Error creating ${name} snapshot:`), message);
        if (suggestOtherTypes) {
            console.log(
                chalk.yellow('⚠️  Try a semi-hot or cold backup instead.'),
            );
        }
        return false;
    };

    // e.g. a sidecar of a killed run, still holding backup locks & disk space.
    const running = await docker(
        [
            'ps',
            '--format',
            '{{.Names}}',
            '--filter',
            `label=${abrLabel}=backup`,
        ],
        { reject: false },
    );
    if (running.stdout?.trim()) {
        // pausing or stopping Appwrite would break the running backup, so no other types.
        return fail(
            `another backup is running (${running.stdout.trim().split('\n').join(', ')}). If not, remove it via "docker rm -f <name>".`,
            false,
        );
    }

    try {
        signal.throwIfAborted();
        await docker(
            ['volume', 'create', '--label', `${abrLabel}=snapshot`, snapshot],
            {
                cancelSignal: signal,
            },
        );
        await database.adapter.snapshot(database, snapshot, signal);
    } catch (error) {
        // execa's messages include the whole command.
        return fail(
            error.stderr?.trim() ||
                (error.exitCode === undefined
                    ? error.message
                    : `exited with code ${error.exitCode}`),
        );
    }

    loader.stop();
    console.log(chalk.green(`✅ ${name} snapshot created.`));
    return true;
}

/**
 * Removes the snapshot container & volume, warns if the volume is left behind.
 *
 * Also stops the given `containers`, e.g. an archive container still using the volume.
 */
export async function removeSnapshot(snapshot, ...containers) {
    await docker(['rm', '-f', snapshot, ...containers], { reject: false });

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
 * {@link removeSnapshot} for a forced exit.
 */
export function removeSnapshotSync(snapshot, ...containers) {
    dockerSync(['rm', '-f', snapshot, ...containers], { reject: false });

    for (let attempt = 0; attempt < 10; attempt++) {
        const { exitCode } = dockerSync(['volume', 'rm', '-f', snapshot], {
            reject: false,
        });
        if (exitCode === 0) return;
        sleepSync(500);
    }

    warnSnapshotLeft(snapshot);
}

/**
 * Warns that a snapshot volume, a full copy of the database, could not be removed.
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
