import chalk from 'chalk';
import {
    appwriteDir,
    appwriteVolumeName,
    docker,
    mariadbVolume,
} from './misc.js';

/**
 * Compose keys of volumes that aren't backed up, as they hold re-downloadable caches.
 * `appwrite-models` holds the embedding service's model weights: large, barely compressible & fetched again on start.
 */
export const cacheVolumes = ['appwrite-models'];

/**
 * Reads the Appwrite install's compose config, resolved by compose itself: `.env`, shell overrides, quoting & comments.
 *
 * @returns {Promise<{project: string, adapter: string, mariadb: {container: string, volume: string|undefined}|null, volumes: string[], excluded: string[], others: string[]}>}
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

    const [key, service] =
        services.find(([, service]) =>
            /(^|\/)mariadb(:|@|$)/.test(service.image ?? ''),
        ) ?? [];
    const source = service?.volumes?.find(
        (volume) =>
            volume.type === 'volume' && volume.target === '/var/lib/mysql',
    )?.source;

    return {
        project: config.name,
        // installs before 1.9 have no adapter setting & always run MariaDB.
        adapter:
            services
                .map(([, service]) => service.environment?._APP_DB_ADAPTER)
                .find(Boolean) ?? (service ? 'mariadb' : 'unknown'),
        mariadb: service
            ? {
                  container:
                      service.container_name ?? `${config.name}-${key}-1`,
                  volume: source && (config.volumes?.[source]?.name ?? source),
              }
            : null,
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

    if (compose.adapter !== 'mariadb') {
        console.error(
            chalk.red(
                `❌ Unsupported database: ${compose.adapter}. Only MariaDB based Appwrite installs are supported.`,
            ),
        );
        return null;
    }

    // e.g. a bind mount or a renamed volume, which restores wouldn't bring back.
    if (compose.mariadb?.volume !== mariadbVolume) {
        console.error(
            chalk.red(
                `❌ Unsupported MariaDB data volume: ${compose.mariadb?.volume ?? 'none'}. Expected "${mariadbVolume}".`,
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
