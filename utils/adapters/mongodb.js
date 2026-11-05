import { docker, helperArgs } from '../misc.js';

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
 * Install files the database's service mounts from the `appwrite` folder, archived with it.
 */
export const files = ['mongo-entrypoint.sh', 'mongo-init.js'];

/**
 * Copies the running MongoDB's files into the `snapshot` volume, write-locked via `fsyncLock` meanwhile.
 *
 * The copy restores like a plain volume. Writes wait during the local copy, not while it is archived.
 *
 * @param database the container's `container` name, `volume` & `image`.
 * @throws when the copy fails or `signal` aborted.
 */
export async function snapshot(database, snapshot, signal) {
    // not cancelled, an interrupted call may still lock.
    await mongosh(database.container, 'db.fsyncLock()');
    try {
        signal.throwIfAborted();
        await docker(
            helperArgs(
                {
                    entrypoint: 'cp',
                    image: database.image,
                    name: snapshot,
                    role: 'backup',
                    mounts: [
                        // not under `/data`, the image's volumes are mounted there.
                        `${database.volume}:/source:ro`,
                        `${snapshot}:/snapshot`,
                    ],
                },
                '-a',
                '/source/.',
                '/snapshot/',
            ),
            { cancelSignal: signal },
        );
    } finally {
        // a lock left behind blocks Appwrite's writes.
        await mongosh(database.container, 'db.fsyncUnlock()');
    }
}

/**
 * Runs `script` in the database container's `mongosh` as root, with the credentials of its environment.
 */
function mongosh(container, script) {
    return docker([
        'exec',
        container,
        'sh',
        '-c',
        'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "$1"',
        'sh',
        script,
    ]);
}
