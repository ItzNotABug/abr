import chalk from 'chalk';
import {
    abrLabel,
    docker,
    dockerSync,
    helperArgs,
    sleep,
    sleepSync,
} from './misc.js';

/**
 * Returns the MariaDB container's `status`, `image` id & `env`, or `null` if it doesn't exist.
 *
 * Throws on any other failure, callers must not mistake it for a stopped database.
 */
export async function inspectMariaDB(container) {
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
 * Whether a running or paused container other than MariaDB's uses its volume. Throws if unknown.
 */
export async function isMariaDBVolumeUsedByOthers({ container, volume }) {
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
 * Stopped MariaDBs are copied as is, this tells if one wrote during the copy, e.g. started or unpaused briefly.
 */
export async function listMariaDBFiles({ volume }) {
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
    return `abr-mariadb-snapshot-${id}`;
}

/**
 * Takes a consistent snapshot of the running MariaDB via `mariadb-backup`, `--prepare`d so it restores like a plain volume.
 *
 * Uses the live container's image, so tool & server versions always match. The caller removes the snapshot.
 *
 * @returns {Promise<boolean>} `true` if the snapshot is ready, `false` if it failed or `signal` aborted.
 */
export async function snapshotMariaDB(loader, mariadb, snapshot, signal) {
    loader.start(chalk.blue('Creating MariaDB snapshot...'));

    const fail = (message, suggestOtherTypes = true) => {
        loader.stop();
        if (signal.aborted) return false;

        console.log(chalk.red('❌ Error creating MariaDB snapshot:'), message);
        if (suggestOtherTypes) {
            console.log(
                chalk.yellow('⚠️  Try a semi-hot or cold backup instead.'),
            );
        }
        return false;
    };

    const credentials = rootCredentials(mariadb.env);
    if (!credentials) {
        return fail(
            `MariaDB root password not found in ${mariadb.container} environment.`,
        );
    }

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

        // password via env, not argv, to keep it out of `ps`. `--init` forwards signals.
        await docker(
            helperArgs(
                {
                    entrypoint: 'sh',
                    image: mariadb.image,
                    name: snapshot,
                    role: 'backup',
                    extra: [
                        '--volumes-from',
                        `${mariadb.container}:ro`,
                        '--network',
                        `container:${mariadb.container}`,
                    ],
                    mounts: [`${snapshot}:/snapshot`],
                    env: ['MYSQL_PWD', 'ABR_PASSWORD_FILE'],
                },
                '-c',
                [
                    'set -e',
                    'if [ -n "$ABR_PASSWORD_FILE" ]; then MYSQL_PWD="$(cat "$ABR_PASSWORD_FILE")"; export MYSQL_PWD; fi',
                    // per-table logs get huge, keep only the tail for errors.
                    'run() { "$@" > /tmp/abr.log 2>&1 || { tail -n 20 /tmp/abr.log >&2; exit 1; }; }',
                    // backup locks only wait on explicit `LOCK TABLES`, fail instead of hanging on them.
                    // `ftwrl-wait-timeout` over its newer `startup-wait-timeout` alias, older images only know the former.
                    'run mariadb-backup --backup --ftwrl-wait-timeout=60 --target-dir=/snapshot --host=127.0.0.1 --port=3306 --user=root',
                    'run mariadb-backup --prepare --target-dir=/snapshot',
                    // skipped by mariadb-backup, needed by the image's healthcheck & upgrade logic.
                    'for f in .my-healthcheck.cnf mysql_upgrade_info mariadb_upgrade_info multi-master.info; do [ -f "/var/lib/mysql/$f" ] && cp -p "/var/lib/mysql/$f" /snapshot/; done',
                    'chown -R mysql:mysql /snapshot',
                ].join('\n'),
            ),
            {
                cancelSignal: signal,
                env: {
                    MYSQL_PWD: credentials.password,
                    ABR_PASSWORD_FILE: credentials.passwordFile,
                },
            },
        );
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
    console.log(chalk.green('✅ MariaDB snapshot created.'));
    return true;
}

/**
 * Removes the snapshot container & volume, warns if the volume is left behind.
 *
 * Also stops the given `containers`, e.g. an archive container still using the volume.
 */
export async function removeMariaDBSnapshot(snapshot, ...containers) {
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
 * {@link removeMariaDBSnapshot} for a forced exit.
 */
export function removeMariaDBSnapshotSync(snapshot, ...containers) {
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
            `⚠️  Found MariaDB snapshots from interrupted backups, they hold full database copies. If no other backup is running, remove them via "docker volume rm ${leftovers.join(' ')}".`,
        ),
    );
}

/**
 * Root credentials like the image's entrypoint: `MARIADB_*` over `MYSQL_*`, each a value or a `*_FILE`.
 */
function rootCredentials(env) {
    const value = (key) =>
        env.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ||
        undefined;

    for (const prefix of ['MARIADB', 'MYSQL']) {
        const password = value(`${prefix}_ROOT_PASSWORD`);
        const passwordFile = value(`${prefix}_ROOT_PASSWORD_FILE`);
        if (password) return { password, passwordFile: '' };
        if (passwordFile) return { password: '', passwordFile };
    }
    return null;
}
