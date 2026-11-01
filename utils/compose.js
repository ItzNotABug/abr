import chalk from 'chalk';
import { appwriteDir, appwriteVolumes, docker } from './misc.js';

/**
 * Reads the Appwrite install's compose config, resolved by compose itself: `.env`, shell overrides, quoting & comments.
 *
 * @returns {Promise<{project: string, adapter: string, mariadb: {container: string, volume: string|undefined}|null}>}
 * @throws when compose fails or prints something unexpected.
 */
export async function readCompose() {
    const { stdout } = await docker(['compose', 'config', '--format', 'json'], {
        cwd: appwriteDir(),
    });
    const config = JSON.parse(stdout);
    const services = Object.entries(config.services);

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

    if (!appwriteVolumes.includes(compose.mariadb?.volume)) {
        console.error(
            chalk.red(
                `❌ Unsupported MariaDB data volume: ${compose.mariadb?.volume ?? 'none'}. Expected one of the default Appwrite volumes.`,
            ),
        );
        return null;
    }

    return compose;
}
