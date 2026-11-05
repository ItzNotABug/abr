import chalk from 'chalk';
import { execa, execaSync } from 'execa';
import * as os from 'os';
import * as path from 'path';

// Pink - The Brand Color
const asciiArt = chalk.hex('#FD366E').bold(`
    _ _     _   ___ ___           _                        _ _         ___          _               ___        _               
  _| | |_  /_\\ | _ ) _ \\  ___    /_\\  _ __ _ ____ __ ___ _(_) |_ ___  | _ ) __ _ __| |___  _ _ __  | _ \\___ __| |_ ___ _ _ ___ 
 |_  .  _|/ _ \\| _ \\   / |___|  / _ \\| '_ \\ '_ \\ V  V / '_| |  _/ -_) | _ \\/ _\` / _| / / || | '_ \\ |   / -_|_-<  _/ _ \\ '_/ -_)
 |_     _/_/ \\_\\___/_|_\\       /_/ \\_\\ .__/ .__/\\_/\\_/|_| |_|\\__\\___| |___/\\__,_\\__|_\\_\\\\_,_| .__/ |_|_\\___/__/\\__\\___/_| \\___|
   |_|_|                             |_|  |_|                                               |_|                                

`);

/**
 * CLI init message.
 */
export const initMessage = `${asciiArt}
${chalk.blue.bold('#ABR - Appwrite Backup Restore')}
${chalk.yellow('A powerful CLI tool for managing complete backups and seamless restorations of your Appwrite instance, ensuring data consistency & quick recovery.')}
${chalk.blue('_'.repeat(146))}
`;

/**
 * Names of Appwrite's own volumes under the default project, the only ones backups take & restores accept.
 */
export const appwriteVolumeName = /^appwrite_appwrite-[a-z0-9-]+$/;

/**
 * Volume names of default Appwrite installs, past & present, to also find unlabelled volumes of earlier restores.
 */
export const defaultVolumes = [
    'builds',
    'cache',
    'certificates',
    'config',
    'executor',
    'functions',
    'imports',
    'mariadb',
    'mongodb',
    'mongodb-keyfile',
    'redis',
    'sites',
    'uploads',
].map((name) => `appwrite_appwrite-${name}`);

/**
 * Install files archived with the volumes, from the `appwrite` folder.
 */
export const installFiles = ['.env', 'docker-compose.yml'];

/**
 * Marks containers & volumes created by ABR, to find leftovers of killed runs.
 * Valued `backup` on the snapshot & archive containers, which hold locks & write.
 */
export const abrLabel = 'com.itznotabug.abr';

/**
 * Image of ABR's helper containers, always pulled for backups as it creates the archives.
 */
export const helperImage = 'offen/docker-volume-backup:latest';

/**
 * `docker run` arguments for an ABR helper container, removed on exit. `--init` makes signals stop it.
 *
 * @param options.role the {@link abrLabel} value.
 * @param options.extra more `docker run` flags.
 */
export function helperArgs(
    {
        entrypoint,
        mounts = [],
        env = [],
        name,
        workdir,
        role = 'helper',
        extra = [],
        image = helperImage,
    },
    ...args
) {
    return [
        'run',
        '--rm',
        '--init',
        '--label',
        `${abrLabel}=${role}`,
        ...(name ? ['--name', name] : []),
        ...extra,
        ...mounts.flatMap((mount) => ['-v', mount]),
        ...env.flatMap((variable) => ['--env', variable]),
        ...(workdir ? ['-w', workdir] : []),
        '--entrypoint',
        entrypoint,
        image,
        ...args,
    ];
}

/**
 * The Appwrite install's directory, `appwrite/` in the current directory.
 */
export function appwriteDir() {
    return path.join(process.cwd(), 'appwrite');
}

let detached = false;

/**
 * While ABR handles interrupts itself, docker commands run in their own process group,
 * so a Ctrl+C reaches only ABR, which then stops or finishes them. Otherwise it stops them too.
 */
function setHandlingInterrupts(handling) {
    detached = handling;
}

/**
 * Routes interrupts to `onInterrupt(signal)` until the returned `release` is called.
 * Meanwhile docker commands run detached & write errors of a hung up terminal are ignored.
 */
export function handleInterrupts(onInterrupt) {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
    // `on`, not `once`: execa's exit hook re-raises the signal if no other listener is left.
    signals.forEach((name) => process.on(name, onInterrupt));
    setHandlingInterrupts(true);

    // a hung up terminal (SIGHUP) fails writes with EIO, don't crash before the cleanup.
    const ignore = () => {};
    process.stdout.on('error', ignore);
    process.stderr.on('error', ignore);

    return () => {
        setHandlingInterrupts(false);
        signals.forEach((name) => process.off(name, onInterrupt));
        process.stdout.off('error', ignore);
        process.stderr.off('error', ignore);
    };
}

export function docker(args, options = {}) {
    return execa('docker', args, { detached, ...options });
}

/**
 * {@link docker} for a forced exit, in ABR's process group as `execaSync` can't detach.
 */
export function dockerSync(args, options = {}) {
    return execaSync('docker', args, options);
}

/**
 * Pulls the images that aren't present yet. Throws on failure.
 */
export async function pullImages(images) {
    for (const image of images) {
        const { failed } = await docker(['image', 'inspect', image], {
            reject: false,
        });
        if (failed) await docker(['pull', image]);
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The shell's exit code for a process ended by `signal`, e.g. 130 for `SIGINT`.
 */
export function signalExitCode(signal) {
    return 128 + os.constants.signals[signal];
}

/**
 * Backup types.
 */
export const backupTypes = [
    {
        value: 'hot-backup',
        name: `${chalk.bold('Hot Backup')} - Fast, Zero Downtime ${chalk.yellow.bold('(Keeps Appwrite running; consistent database snapshot, files copied live)')}`,
    },
    {
        value: 'semi-hot-backup',
        name: `${chalk.bold('Semi-Hot Backup')} - Minimal Downtime, Ensured Consistency ${chalk.yellow.bold('(Pauses Appwrite briefly for data safety)')}`,
    },
    {
        value: 'cold-backup',
        name: `${chalk.bold('Cold Backup')} - Slow, Full Consistency ${chalk.green.bold('(Brief downtime; stops Appwrite for guaranteed data consistency)')}`,
    },
];

/**
 * Checks if `Docker` is installed and running.
 */
export async function checkDocker(loader) {
    loader.start('Checking if available Docker...');

    try {
        await execa('docker', ['info']);
        loader.stop();

        console.log(chalk.green('✅ Docker is running.'));
        return true;
    } catch (error) {
        loader.stop();

        if (error.code === 'ENOENT') {
            console.log(
                chalk.red('❌ Error: Docker is not installed on your system.'),
            );
        } else {
            console.log(
                chalk.red(
                    '❌ Error: Docker is not running. Please start Docker and try again.',
                ),
            );
        }
        return false;
    }
}

/**
 * Restarts the appwrite stack.
 *
 * This will take a while because this also fetches all the pruned images from docker hub.
 *
 * @param onStart gets the running `docker compose` command.
 * @returns {Promise<boolean>} whether it worked.
 */
export async function restartAppwriteStack(loader, onStart = () => {}) {
    loader.start(chalk.blue('Restarting appwrite (This can take a while...)'));
    try {
        const command = docker(['compose', 'up', '-d'], { cwd: appwriteDir() });
        onStart(command);
        await command;

        loader.stop();
        console.log(chalk.green('✅ Appwrite stack restarted.'));
        return true;
    } catch (error) {
        loader.stop();
        console.error(
            chalk.red('❌ Error during Appwrite restart:'),
            error.message,
        );
        process.exitCode = 1;
        return false;
    }
}

/**
 * Resumes the appwrite stack.
 *
 * @param onStart gets the running `docker compose` command.
 * @returns {Promise<boolean>} whether it worked.
 */
export async function resumeAppwriteStack(loader, onStart = () => {}) {
    loader.start(chalk.blue('Resuming appwrite'));
    try {
        const command = docker(['compose', 'unpause'], { cwd: appwriteDir() });
        onStart(command);
        await command;

        loader.stop();
        console.log(chalk.green('✅ Appwrite stack resumed.'));
        return true;
    } catch (error) {
        loader.stop();
        console.error(
            chalk.red('❌ Error during Appwrite resumption:'),
            error.message,
        );
        process.exitCode = 1;
        return false;
    }
}
