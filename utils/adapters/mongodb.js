import { appwriteDir, docker, envValue, helperArgs } from '../misc.js';

export const name = 'MongoDB';

/**
 * The database's volume in supported installs.
 */
export const volume = 'appwrite_appwrite-mongodb';

/**
 * Finds the database's compose service by its image.
 */
export const image = /(^|\/)mongo(:|@|$)/;

/**
 * Where the database's volume is mounted in its container.
 */
export const dataDir = '/data/db';

/**
 * Files in the volume that snapshots skip, none as the dump replaces them all.
 */
export const skipped = [];

/**
 * The dump hot backups archive in place of the volume's files.
 */
export const dumpFile = 'mongodb.archive.gz';

/**
 * Dumps the running MongoDB into the `snapshot` volume via `mongodump --oplog`, consistent as of the dump's end.
 *
 * Appwrite keeps running & writing, the dump only adds read load.
 * Uses the live container's image, which ships the tools. The password goes via stdin, never argv.
 *
 * @param database the container's `container` name, `image` & `env`.
 * @throws when the dump fails or `signal` aborted.
 */
export async function snapshot(database, snapshot, signal) {
    // as the image's entrypoint creates them.
    const user = envValue(database.env, 'MONGO_INITDB_ROOT_USERNAME');
    const password = envValue(database.env, 'MONGO_INITDB_ROOT_PASSWORD');
    if (!user || !password) {
        throw new Error(
            `MongoDB root credentials not found in ${database.container} environment.`,
        );
    }

    await docker(
        helperArgs(
            {
                entrypoint: 'mongodump',
                image: database.image,
                name: snapshot,
                extra: ['-i', '--network', `container:${database.container}`],
                mounts: [`${snapshot}:/snapshot`],
            },
            '--quiet',
            '--host=127.0.0.1',
            `--username=${user}`,
            '--authenticationDatabase=admin',
            `--archive=/snapshot/${dumpFile}`,
            '--gzip',
            '--oplog',
        ),
        { cancelSignal: signal, input: `${password}\n` },
    );
}

/**
 * Loads the dump a restore extracted into the empty volume, via a temporary mongod of the compose `service` without auth.
 *
 * The dump brings the users back, so the service's entrypoint skips its init & its healthcheck sets the replica set up again.
 * With auth, restoring the users would end mongorestore's own login.
 */
export async function restoreDump(service) {
    await docker(
        [
            'compose',
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--entrypoint',
            'sh',
            service,
            '-c',
            // `--stopOnError`, mongorestore otherwise skips documents it can't insert & still exits 0.
            `set -e
fail() { tail -n 20 "$1" >&2; exit 1; }
mongod --dbpath ${dataDir} --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod.log --quiet >/dev/null || fail /tmp/mongod.log
mongorestore --stopOnError --archive=${dataDir}/${dumpFile} --gzip --oplogReplay 2>/tmp/mongorestore.log || fail /tmp/mongorestore.log
mongod --dbpath ${dataDir} --shutdown
rm ${dataDir}/${dumpFile}
# as the image's own user, not root, in case the service starts mongod as it.
chown -R mongodb:mongodb ${dataDir}`,
        ],
        { cwd: appwriteDir() },
    );
}
