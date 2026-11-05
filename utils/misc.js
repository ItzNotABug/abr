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
 * A variable's value from the `KEY=value` list of `docker inspect`.
 */
export function envValue(env, key) {
    return env
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1);
}

/**
 * Marks containers & volumes created by ABR, to find leftovers of killed runs.
 */
export const abrLabel = 'com.itznotabug.abr';

/**
 * Image of ABR's helper containers, it creates the archives. `docker run` pulls it if missing.
 */
const helperImage = 'offen/docker-volume-backup:latest';

/**
 * `docker run` arguments for an ABR helper container, removed on exit. `--init` makes signals stop it.
 *
 * @param options.extra more `docker run` flags.
 */
export function helperArgs(
    {
        entrypoint,
        mounts = [],
        env = [],
        name,
        workdir,
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
        `${abrLabel}=helper`,
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

/**
 * Signals ABR handles, to clean up or release its lock.
 */
export const exitSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * While ABR handles interrupts itself, docker commands run in their own process group,
 * so a Ctrl+C reaches only ABR, which then stops or finishes them. Otherwise it stops them too.
 */
let detached = false;

/**
 * Routes interrupts to `onInterrupt(signal)` until the returned `release` is called.
 * Meanwhile docker commands run detached & write errors of a hung up terminal are ignored.
 */
export function handleInterrupts(onInterrupt) {
    // `on`, not `once`: execa's exit hook re-raises the signal if no other listener is left.
    exitSignals.forEach((name) => process.on(name, onInterrupt));
    detached = true;

    // a hung up terminal (SIGHUP) fails writes with EIO, don't crash before the cleanup.
    const ignore = () => {};
    process.stdout.on('error', ignore);
    process.stderr.on('error', ignore);

    return () => {
        detached = false;
        exitSignals.forEach((name) => process.off(name, onInterrupt));
        process.stdout.off('error', ignore);
        process.stderr.off('error', ignore);
    };
}

export function docker(args, options = {}) {
    return execa('docker', args, { detached, ...options });
}

/**
 * Blocks for `ms`, in a forced exit nothing async runs anymore.
 */
export function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * {@link docker} for a forced exit, best effort, in ABR's process group as `execaSync` can't detach.
 */
export function dockerSync(args) {
    return execaSync('docker', args, {
        reject: false,
        timeout: 10_000,
        // a child ignoring the default SIGTERM would keep blocking the exit.
        killSignal: 'SIGKILL',
    });
}

/**
 * Prints an error under `title`, with docker's own words if it came from a command.
 */
export function printError(title, error) {
    console.error(
        chalk.red(`❌ ${title}`),
        error.stderr?.trim() || error.message,
    );
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
 * `docker compose` steps on the Appwrite stack, for {@link runCompose}.
 * `restart` takes a while, it may also fetch missing images from docker hub.
 * `harmless` is an error that counts as done.
 */
export const composeSteps = {
    stop: {
        args: ['down'],
        start: 'Stopping Appwrite services...',
        done: 'Appwrite services stopped.',
        failed: 'Error stopping Appwrite services:',
    },
    pause: {
        args: ['pause'],
        start: 'Pausing Appwrite services...',
        done: 'Appwrite services paused.',
        failed: 'Error pausing Appwrite services:',
        harmless: 'already paused',
    },
    restart: {
        args: ['up', '-d'],
        start: 'Restarting appwrite (This can take a while...)',
        done: 'Appwrite stack restarted.',
        failed: 'Error during Appwrite restart:',
    },
    resume: {
        args: ['unpause'],
        start: 'Resuming appwrite',
        done: 'Appwrite stack resumed.',
        failed: 'Error during Appwrite resumption:',
    },
};

/**
 * Runs a {@link composeSteps} step on the Appwrite stack, printing how it went.
 *
 * @param stack gets the running command as `command`, to kill it on a forced exit.
 * @returns {Promise<boolean>} whether it worked.
 */
export async function runCompose(
    loader,
    { args, start, done, failed, harmless },
    stack = {},
) {
    loader.start(chalk.blue(start));
    try {
        stack.command = docker(['compose', ...args], { cwd: appwriteDir() });
        await stack.command;

        loader.stop();
        console.log(chalk.green(`✅ ${done}`));
        return true;
    } catch (error) {
        loader.stop();
        if (harmless && error.message.includes(harmless)) return true;

        console.error(chalk.red(`❌ ${failed}`), error.message);
        process.exitCode = 1;
        return false;
    }
}
