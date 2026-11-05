import { appwriteDir, docker, helperArgs } from '../misc.js';

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
    const { user, password } = rootCredentials(database.env);
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
                role: 'backup',
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
 * Loads the dump a restore extracted into the empty volume, via a temporary mongod of the service without auth.
 *
 * The dump brings the users back, so the service's entrypoint skips its init & its healthcheck sets the replica set up again.
 * With auth, restoring the users would end mongorestore's own login.
 */
export async function restoreDump() {
    await docker(
        [
            'compose',
            'run',
            '--rm',
            '--no-deps',
            '-T',
            '--entrypoint',
            'sh',
            'mongodb',
            '-c',
            `set -e
mongod --dbpath ${dataDir} --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod.log --quiet
mongorestore --quiet --archive=${dataDir}/${dumpFile} --gzip --oplogReplay
mongod --dbpath ${dataDir} --shutdown
rm ${dataDir}/${dumpFile}`,
        ],
        { cwd: appwriteDir() },
    );
}

/**
 * Root credentials as the image's entrypoint creates them.
 */
function rootCredentials(env) {
    const value = (key) =>
        env.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
    return {
        user: value('MONGO_INITDB_ROOT_USERNAME'),
        password: value('MONGO_INITDB_ROOT_PASSWORD'),
    };
}
