import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { adapters } from './adapters/index.js';
import { appwriteDir, appwriteVolumeName, docker } from './misc.js';

/**
 * Compose keys of volumes that aren't backed up, as they hold re-downloadable caches.
 * `appwrite-models` holds the embedding service's model weights: large, barely compressible & fetched again on start.
 */
export const cacheVolumes = ['appwrite-models'];

/**
 * Reads the Appwrite install's compose config, resolved by compose itself: `.env`, shell overrides, quoting & comments.
 *
 * @returns {Promise<{project: string, database: {adapter: object|null, container: string|undefined, volume: string|undefined, files: string[]}, volumes: string[], excluded: string[], others: string[]}>}
 * `database` is the service of the `_APP_DB_ADAPTER`, its `adapter` from {@link adapters} or `null` if unsupported.
 * Its `files` are the ones it mounts from the `appwrite` folder, archived with it.
 * `volumes` are Appwrite's volumes to back up, `excluded` its caches & `others` volumes added to the install, neither backed up.
 * @throws when compose fails or prints something unexpected.
 */
export async function readCompose() {
    const { stdout } = await docker(['compose', 'config', '--format', 'json'], {
        cwd: appwriteDir(),
    });
    const config = JSON.parse(stdout);
    const services = Object.entries(config.services);
    const volumes = Object.entries(config.volumes ?? {});
    const named = volumes.map(([key, volume]) => [key, volume.name ?? key]);
    // restores only accept Appwrite's own volume names, others would make a backup unrestorable.
    const own = named.filter(([, name]) => appwriteVolumeName.test(name));
    const names = (excluded) =>
        own
            .filter(([key]) => cacheVolumes.includes(key) === excluded)
            .map(([, name]) => name);

    // installs before 1.9 have no adapter setting & always run MariaDB.
    const name =
        services
            .map(([, service]) => service.environment?._APP_DB_ADAPTER)
            .find(Boolean) ?? 'mariadb';
    const adapter = Object.hasOwn(adapters, name) ? adapters[name] : null;
    const [key, service] =
        (adapter &&
            services.find(([, service]) =>
                adapter.image.test(service.image ?? ''),
            )) ??
        [];
    const mounts = service?.volumes ?? [];
    const source = mounts.find(
        (volume) =>
            volume.type === 'volume' && volume.target === adapter.dataDir,
    )?.source;

    return {
        project: config.name,
        database: {
            adapter,
            container:
                service &&
                (service.container_name ?? `${config.name}-${key}-1`),
            volume: source && (config.volumes?.[source]?.name ?? source),
            // e.g. MongoDB's entrypoint & init script.
            files: mounts
                .filter(
                    (mount) =>
                        mount.type === 'bind' &&
                        // files only, a folder or a missing file can't be archived as one.
                        fs
                            .statSync(mount.source, { throwIfNoEntry: false })
                            ?.isFile() &&
                        // real paths, compose may resolve a symlinked folder.
                        realPath(path.dirname(mount.source)) ===
                            realPath(appwriteDir()),
                )
                .map((mount) => path.basename(mount.source)),
        },
        volumes: names(false),
        excluded: names(true),
        others: named
            .filter(([, name]) => !appwriteVolumeName.test(name))
            .map(([, name]) => name),
    };
}

/**
 * {@link readCompose} for backups, `null` with the reason printed if the install isn't supported.
 */
export async function readBackupCompose() {
    let compose;
    try {
        compose = await readCompose();
    } catch (error) {
        console.error(
            chalk.red('❌ Could not read the Appwrite compose config:'),
            error.stderr?.trim() || error.message,
        );
        return null;
    }

    const { adapter } = compose.database;
    if (!adapter) {
        console.error(
            chalk.red(
                `❌ Unsupported database, see _APP_DB_ADAPTER. Only ${Object.values(
                    adapters,
                )
                    .map(({ name }) => name)
                    .join(' & ')} based Appwrite installs are supported.`,
            ),
        );
        return null;
    }

    // e.g. a bind mount or a renamed volume, which restores wouldn't bring back.
    if (compose.database.volume !== adapter.volume) {
        console.error(
            chalk.red(
                `❌ Unsupported ${adapter.name} data volume: ${compose.database.volume ?? 'none'}. Expected "${adapter.volume}".`,
            ),
        );
        return null;
    }

    if (compose.others.length) {
        console.log(
            chalk.yellow(
                `⚠️  Not backed up, these volumes aren't Appwrite's own: ${compose.others.join(', ')}.`,
            ),
        );
    }

    return compose;
}

/**
 * The path with symlinks resolved, as is if it doesn't exist.
 */
function realPath(target) {
    try {
        return fs.realpathSync(target);
    } catch {
        return target;
    }
}
