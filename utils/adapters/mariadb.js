import { docker, envValue, helperArgs } from '../misc.js';

export const name = 'MariaDB';

/**
 * The database's volume in supported installs.
 */
export const volume = 'appwrite_appwrite-mariadb';

/**
 * Finds the database's compose service by its image.
 */
export const image = /(^|\/)mariadb(:|@|$)/;

/**
 * Where the database's volume is mounted in its container.
 */
export const dataDir = '/var/lib/mysql';

/**
 * Files in the volume that snapshots skip: temp & redo logs, rebuilt by `--prepare`.
 */
export const skipped = ['ibtmp1', 'ib_logfile*'];

/**
 * Snapshots the running MariaDB into the `snapshot` volume via `mariadb-backup`, `--prepare`d so it restores like a plain volume.
 *
 * Uses the live container's image, so tool & server versions always match.
 *
 * @param database the container's `container` name, `image` & `env`.
 * @throws when the snapshot fails or `signal` aborted.
 */
export async function snapshot(database, snapshot, signal) {
    const password = rootPassword(database.env);
    if (!password) {
        throw new Error(
            `MariaDB root password not found in ${database.container} environment.`,
        );
    }

    // password via env, not argv, to keep it out of `ps`. `--init` forwards signals.
    await docker(
        helperArgs(
            {
                entrypoint: 'sh',
                image: database.image,
                name: snapshot,
                extra: [
                    '--volumes-from',
                    `${database.container}:ro`,
                    '--network',
                    `container:${database.container}`,
                ],
                mounts: [`${snapshot}:/snapshot`],
                env: ['MYSQL_PWD'],
            },
            '-c',
            [
                'set -e',
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
        { cancelSignal: signal, env: { MYSQL_PWD: password } },
    );
}

/**
 * Root password like the image's entrypoint: `MARIADB_*` over `MYSQL_*`.
 */
function rootPassword(env) {
    return (
        envValue(env, 'MARIADB_ROOT_PASSWORD') ||
        envValue(env, 'MYSQL_ROOT_PASSWORD')
    );
}
