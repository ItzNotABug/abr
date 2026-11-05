import * as fs from 'fs';
import chalk from 'chalk';
import Table from 'cli-table3';
import { backupsDir } from './archives.js';
import { docker, helperArgs } from './misc.js';

/**
 * The given volumes that exist, `docker run -v` would create the others.
 */
export async function existingVolumes(volumes) {
    const { stdout } = await docker(['volume', 'ls', '--format', '{{.Name}}']);
    const existing = stdout.split('\n');
    return volumes.filter((volume) => existing.includes(volume));
}

/**
 * Measures the volumes & the free space where a backup writes, in KB.
 *
 * `tmp` is the container layer, where offen builds archives. `scratch` is a new volume, like the snapshot's.
 * Filesystems are identified by their size: the overlay `/tmp` & btrfs subvolumes report other ids for the same disk.
 *
 * @param volumes existing volumes.
 * @param databaseVolume the database's volume.
 * @param globs the files in it that its snapshots skip, measured as `skipped`.
 * @returns {Promise<{sizes: Map<string, number>, skipped: number, tmp: Disk, scratch: Disk, archive: Disk}>} with `Disk` as `{id, free}`.
 */
export async function measureVolumes(volumes, databaseVolume, globs) {
    fs.mkdirSync(backupsDir(), { recursive: true });

    const { stdout } = await docker(
        helperArgs(
            {
                entrypoint: 'sh',
                mounts: [
                    ...volumes.map(
                        (volume) => `${volume}:/volumes/${volume}:ro`,
                    ),
                    `${backupsDir()}:/archive:ro`,
                    // anonymous, removed with the container.
                    '/scratch',
                ],
                workdir: '/volumes',
            },
            '-c',
            // du fails on files deleted while it runs, its sizes are still printed.
            [
                'du -sk -- "$@" 2>/dev/null',
                'echo --',
                'stat -f -c "%b %a %S" /tmp /scratch /archive',
                'echo --',
                // `/dev/null` counts as 0, without files du would measure the folder.
                `du -sck ${globs.map((glob) => `"$0"/${glob}`).join(' ')} /dev/null 2>/dev/null | tail -n 1`,
            ].join('\n'),
            databaseVolume,
            ...volumes,
        ),
    );

    const [du, stat, skipped] = stdout.split(/^--$/m).map((section) =>
        section
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => line.trim().split(/\s+/)),
    );
    const sizes = new Map(du.map(([kb, name]) => [name, Number(kb)]));
    // in argument order.
    const [tmp, scratch, archive] = stat.map(([total, free, blockSize]) => ({
        id: Number(total) * Number(blockSize),
        free: Math.floor((Number(free) * Number(blockSize)) / 1024),
    }));
    if (volumes.some((volume) => !sizes.has(volume)) || !archive) {
        throw new Error('unexpected output.');
    }

    return {
        sizes,
        skipped: Number(skipped?.[0]?.[0] ?? 0),
        tmp,
        scratch,
        archive,
    };
}

/**
 * Prints the volume sizes, `n/a` for the given volumes that don't exist.
 *
 * @param excluded volumes listed as not backed up.
 */
export function printVolumeSizes({ sizes }, volumes, excluded = []) {
    const table = new Table({
        head: [chalk.blue('Volume Name'), chalk.blue('Size')],
        colWidths: [40, 15],
    });
    volumes.forEach((volume) =>
        table.push([
            chalk.yellow(volume),
            sizes.has(volume)
                ? chalk.green(formatSize(sizes.get(volume)))
                : chalk.red('n/a'),
        ]),
    );
    excluded.forEach((volume) =>
        table.push([chalk.gray(volume), chalk.gray('excluded')]),
    );
    console.log(table.toString());
}

/**
 * Whether there's room for the backup, prints the reason if not.
 *
 * Required: the snapshot & its compressed copy, at most its size, on Docker's disk next to the live database.
 * The whole archive is estimated without compression, so the user may go ahead anyway.
 *
 * @param measure from {@link measureVolumes}.
 * @param databaseVolume the database's volume.
 * @param snapshotted whether the database is snapshotted first, which skips the measured `skipped` files.
 * @param encrypted whether the archive is encrypted, offen keeps both copies in its `/tmp` meanwhile.
 * @param dumped whether the snapshot is a compressed dump, the volume's size then covers it & its archived copy.
 * @returns {'ok'|'snapshot'|'archive'} what may not fit.
 */
export function checkDiskSpace(
    measure,
    databaseVolume,
    snapshotted,
    encrypted,
    dumped,
) {
    const skipped = snapshotted ? measure.skipped : 0;
    const snapshot = snapshotted
        ? measure.sizes.get(databaseVolume) - skipped
        : 0;
    const total =
        [...measure.sizes.values()].reduce((a, b) => a + b, 0) - skipped;

    if (
        snapshot &&
        // as one disk: ZFS, overlay quotas & VMs report other sizes for the same space.
        !fits([
            [
                {
                    ...measure.scratch,
                    free: Math.min(measure.scratch.free, measure.tmp.free),
                },
                dumped ? snapshot : snapshot * 2,
            ],
        ])
    ) {
        return 'snapshot';
    }

    // offen builds the archive in its `/tmp`, then copies it to `backups/`.
    return fits([
        [measure.scratch, snapshot],
        [measure.tmp, encrypted ? total * 2 : total],
        [measure.archive, total],
    ])
        ? 'ok'
        : 'archive';
}

/**
 * Whether the needs fit with 10% headroom, prints the first that doesn't.
 *
 * @param needs `[disk, kb]` pairs, summed per filesystem.
 * Same-size disks are summed too, with the lower free space: too strict rather than too lax.
 */
function fits(needs) {
    const byDisk = new Map();
    for (const [disk, kb] of needs) {
        const entry = byDisk.get(disk.id) ?? { free: disk.free, need: 0 };
        entry.need += kb;
        entry.free = Math.min(entry.free, disk.free);
        byDisk.set(disk.id, entry);
    }

    for (const { free, need } of byDisk.values()) {
        const required = Math.ceil(need * 1.1);
        if (free >= required) continue;

        console.log(
            chalk.yellow(
                `⚠️  The backup may need up to ${formatSize(required)} on one disk, ${formatSize(free)} free.`,
            ),
        );
        return false;
    }
    return true;
}

export function formatSize(kb) {
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = kb;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
