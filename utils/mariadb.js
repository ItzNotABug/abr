import chalk from 'chalk';
import { execa, execaSync } from 'execa';
import * as path from 'path';
import { mariadbVolume } from './misc.js';

/**
 * Appwrite's MariaDB container.
 */
const mariadbContainer = 'appwrite-mariadb';

/**
 * Marks snapshot containers & volumes, to find leftovers of killed runs.
 */
export const snapshotLabel = 'com.itznotabug.abr.snapshot';

/**
 * Checks that the installation runs on MariaDB,
 * Appwrite 1.9+ may also use MongoDB or PostgreSQL.
 */
export async function checkDatabaseAdapter() {
    // resolved by compose itself: `.env`, shell overrides, quoting & comments.
    const config = await execa(
        'docker',
        ['compose', 'config', '--format', 'json'],
        { cwd: path.join(process.cwd(), 'appwrite'), reject: false },
    );

    let services;
    try {
        services = Object.values(JSON.parse(config.stdout).services);
    } catch {
        console.error(
            chalk.red('❌ Could not read the Appwrite compose config:'),
            config.stderr?.trim() || config.message || 'unexpected output.',
        );
        return false;
    }

    // installs before 1.9 have no adapter setting & always run MariaDB.
    const adapter =
        services
            .map((service) => service.environment?._APP_DB_ADAPTER)
            .find(Boolean) ??
        (services.some((service) =>
            /(^|\/)mariadb(:|@|$)/.test(service.image ?? ''),
        )
            ? 'mariadb'
            : 'unknown');
    if (adapter === 'mariadb') return true;

    console.error(
        chalk.red(
            `❌ Unsupported database: ${adapter}. Only MariaDB based Appwrite installs are supported.`,
        ),
    );
    return false;
}

/**
 * Returns the MariaDB container's `status`, `startedAt`, `image` id & `env`, or `null` if it doesn't exist.
 *
 * Throws on any other failure, callers must not mistake it for a stopped database.
 */
export async function inspectMariaDB() {
    const { failed, stdout, stderr } = await execa(
        'docker',
        ['container', 'inspect', mariadbContainer],
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
            startedAt: State.StartedAt,
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
export async function isMariaDBVolumeUsedByOthers() {
    const { failed, stdout, stderr } = await execa(
        'docker',
        ['ps', '--format', '{{.Names}}', '--filter', `volume=${mariadbVolume}`],
        { reject: false },
    );
    if (failed) throw new Error(stderr?.trim() || 'docker ps failed.');

    return stdout.split('\n').some((name) => name && name !== mariadbContainer);
}

/**
 * Returns a unique snapshot container & volume name, without `appwrite` as restores remove volumes by that filter.
 */
export function snapshotName() {
    return `abr-mariadb-snapshot-${Date.now()}`;
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

    const fail = async (message, suggestOtherTypes = true) => {
        loader.stop();

        // the same Ctrl+C can fail the docker CLI before the abort handler runs.
        await new Promise((resolve) => setTimeout(resolve, 100));
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
            `MariaDB root password not found in ${mariadbContainer} environment.`,
        );
    }

    // e.g. a sidecar of a killed run, still holding backup locks & disk space.
    const running = await execa(
        'docker',
        ['ps', '--format', '{{.Names}}', '--filter', `label=${snapshotLabel}`],
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
        await execa(
            'docker',
            ['volume', 'create', '--label', snapshotLabel, snapshot],
            { cancelSignal: signal },
        );

        // password via env, not argv, to keep it out of `ps`. `--init` forwards signals.
        await execa(
            'docker',
            [
                'run',
                '--rm',
                '--init',
                '--name',
                snapshot,
                '--label',
                snapshotLabel,
                '--volumes-from',
                `${mariadbContainer}:ro`,
                '--network',
                `container:${mariadbContainer}`,
                '-v',
                `${snapshot}:/snapshot`,
                '-e',
                'MYSQL_PWD',
                '-e',
                'ABR_PASSWORD_FILE',
                '--entrypoint',
                'sh',
                mariadb.image,
                '-c',
                [
                    'set -e',
                    'if [ -n "$ABR_PASSWORD_FILE" ]; then MYSQL_PWD="$(cat "$ABR_PASSWORD_FILE")"; export MYSQL_PWD; fi',
                    // a full copy on the live database's disk, kept while its compressed copy is archived.
                    // so room for both, plus headroom. temp & redo log files are excluded.
                    'size=$(du -sk --exclude=ibtmp1 --exclude="ib_logfile*" /var/lib/mysql 2>/dev/null | cut -f1)',
                    "free=$(df -Pk /snapshot | awk 'NR == 2 { print $4 }')",
                    'if [ -z "$size" ] || [ -z "$free" ]; then echo "could not determine the free disk space." >&2; exit 1; fi',
                    'need=$((size * 2 + size / 10))',
                    'if [ "$free" -le "$need" ]; then echo "not enough disk space, the snapshot & its compressed copy need ~$((need / 1024)) MB, $((free / 1024)) MB free." >&2; exit 1; fi',
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
            ],
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
    await execa('docker', ['rm', '-f', snapshot, ...containers], {
        reject: false,
    });

    // stays in use briefly while an interrupted sidecar is torn down.
    for (let attempt = 0; attempt < 10; attempt++) {
        const { exitCode } = await execa(
            'docker',
            ['volume', 'rm', '-f', snapshot],
            { reject: false },
        );
        if (exitCode === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    warnSnapshotLeft(snapshot);
}

/**
 * {@link removeMariaDBSnapshot} for a forced exit.
 */
export function removeMariaDBSnapshotSync(snapshot, ...containers) {
    execaSync('docker', ['rm', '-f', snapshot, ...containers], {
        reject: false,
    });

    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 10; attempt++) {
        const { exitCode } = execaSync(
            'docker',
            ['volume', 'rm', '-f', snapshot],
            { reject: false },
        );
        if (exitCode === 0) return;
        Atomics.wait(pause, 0, 0, 500);
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
    const { stdout } = await execa(
        'docker',
        ['volume', 'ls', '-q', '--filter', `label=${snapshotLabel}`],
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
