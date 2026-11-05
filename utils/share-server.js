import * as fs from 'fs';
import chalk from 'chalk';
import * as http from 'http';
import * as crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { formatSize } from './volumes.js';

/**
 * A random URL token & Basic auth password, the user is always `abr`.
 * `probe` is a path that only answers `OK`, to check the server is reachable.
 */
export function newCredentials() {
    const password = crypto.randomBytes(18).toString('base64url');
    return {
        token: crypto.randomBytes(24).toString('base64url'),
        probe: crypto.randomBytes(24).toString('base64url'),
        password,
        credentials: `abr:${password}`,
    };
}

/**
 * Serves the share's info page at `/<token>/` & its file at `/<token>/<name>`, both behind Basic auth.
 * On localhost only, the tunnel shares the host's network.
 *
 * @param share `{file, name, size, sha256, token, probe, credentials, deadline, url, active, finishedAt, expired}`.
 * `active` counts running downloads, `finishedAt` is when the last one ended, once `expired` new requests are refused.
 * @param log prints download events.
 */
export async function startServer(share, log) {
    const server = http.createServer((request, response) =>
        handleRequest(request, response, share, log),
    );
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    // e.g. EMFILE while accepting, unhandled it would crash the share without cleanup.
    server.on('error', (error) => log(`server error: ${error.message}`));
    return server;
}

/**
 * Stops the server, along with running downloads.
 */
export function stopServer(server) {
    server.closeAllConnections();
    server.close();
}

/**
 * A resumable download, curl asks for the password.
 */
export function curlCommand({ url, token, name }) {
    return `curl -fL -C - -u abr -o ${quote(name)} ${quote(`${url}/${token}/${encodeURIComponent(name)}`)}`;
}

/**
 * Quotes for POSIX shells.
 */
function quote(text) {
    return `'${text.replaceAll("'", `'\\''`)}'`;
}

function handleRequest(request, response, share, log) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex');
    response.setHeader('Referrer-Policy', 'no-referrer');

    // unknown paths look the same with or without credentials.
    const parts = request.url.split('?')[0].split('/');
    if (parts.length === 2 && safeEqual(parts[1], share.probe)) {
        return send(response, 200, 'OK.');
    }
    if (parts.length > 3 || !safeEqual(parts[1], share.token)) {
        return send(response, 404, 'Not found.');
    }
    if (share.expired) {
        return send(response, 410, 'This link has expired.');
    }
    if (!safeEqual(basicCredentials(request), share.credentials)) {
        return send(response, 401, 'Unauthorized.', {
            'WWW-Authenticate': 'Basic realm="abr", charset="UTF-8"',
        });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        return send(response, 405, 'Method not allowed.', {
            Allow: 'GET, HEAD',
        });
    }

    if (parts.length === 2) {
        return send(response, 308, 'Moved.', {
            Location: `/${share.token}/`,
        });
    }
    if (parts[2] === '') {
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
                "default-src 'none'; style-src 'unsafe-inline'",
        });
        return response.end(request.method === 'HEAD' ? '' : page(share));
    }
    if (parts[2] !== encodeURIComponent(share.name)) {
        return send(response, 404, 'Not found.');
    }

    download(request, response, share, log);
}

function send(response, code, text, headers = {}) {
    response.writeHead(code, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...headers,
    });
    response.end(`${text}\n`);
}

/**
 * Sends the file, or the requested range of it to resume a download.
 */
function download(request, response, share, log) {
    const etag = `"${share.sha256}"`;
    const ifRange = request.headers['if-range'];
    const range =
        !ifRange || ifRange === etag
            ? parseRange(request.headers.range, share.size)
            : null;
    if (range === 'unsatisfiable') {
        return send(response, 416, 'Range not satisfiable.', {
            'Content-Range': `bytes */${share.size}`,
        });
    }

    const { start, end } = range ?? { start: 0, end: share.size - 1 };
    response.writeHead(range ? 206 : 200, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Disposition': `attachment; filename="${share.name.replace(/[^\w.-]/g, '_')}"`,
        ETag: etag,
        ...(range && {
            'Content-Range': `bytes ${start}-${end}/${share.size}`,
        }),
    });
    if (request.method === 'HEAD') return response.end();

    const from = request.headers['cf-connecting-ip'] ?? 'unknown';
    const offset = start ? `, from ${formatSize(start / 1024)}` : '';
    share.active++;
    log(chalk.blue(`⬇️  Download started by ${from}${offset}.`));
    pipeline(fs.createReadStream(share.file, { start, end }), response).then(
        () => {
            share.active--;
            share.finishedAt = Date.now();
            log(chalk.green(`✅ Download finished by ${from}.`));
        },
        () => {
            share.active--;
            share.finishedAt = Date.now();
            log(chalk.yellow(`⚠️  Download stopped by ${from}.`));
        },
    );
}

/**
 * A single `bytes=` range, `null` to send the whole file, as for multiple or invalid ranges.
 *
 * @returns {{start: number, end: number}|'unsatisfiable'|null}
 */
function parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
    if (!match || (!match[1] && !match[2])) return null;

    const [, first, last] = match;
    if (!first) {
        // a suffix, the last n bytes.
        const length = Number(last);
        return length
            ? { start: Math.max(0, size - length), end: size - 1 }
            : 'unsatisfiable';
    }

    const start = Number(first);
    const end = last ? Math.min(Number(last), size - 1) : size - 1;
    if (last && Number(last) < start) return null;
    return start < size ? { start, end } : 'unsatisfiable';
}

/**
 * The `user:password` of a Basic `Authorization` header, empty if none.
 */
function basicCredentials(request) {
    const [, encoded] =
        /^basic\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '') ?? [];
    return encoded ? Buffer.from(encoded, 'base64').toString() : '';
}

/**
 * Compares in constant time, for the token & credentials.
 */
function safeEqual(a = '', b = '') {
    const digest = (value) =>
        crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
}

function page(share) {
    const escape = (text) =>
        String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
    const name = escape(share.name);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Appwrite backup</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
code, pre { font: 14px ui-monospace, monospace; background: #f4f4f5; border-radius: 4px; }
pre { padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
a.download { display: inline-block; padding: 0.5rem 1rem; background: #fd366e; color: #fff; border-radius: 6px; text-decoration: none; }
</style>
</head>
<body>
<h1>Appwrite backup</h1>
<p>
<b>File:</b> <code>${name}</code><br>
<b>Size:</b> ${escape(formatSize(share.size / 1024))} (${share.size} bytes)<br>
<b>SHA-256:</b> <code>${share.sha256}</code><br>
<b>Link expires:</b> ${escape(new Date(share.deadline).toUTCString())}
</p>
<p><a class="download" href="${escape(encodeURIComponent(share.name))}" download>Download</a></p>
<p>Or via curl, resumable if interrupted, it asks for the password:</p>
<pre>${escape(curlCommand(share))}</pre>
<p>Check the download:</p>
<pre>echo ${escape(quote(`${share.sha256}  ${share.name}`))} | sha256sum -c</pre>
<p>The backup is encrypted. Put it in <code>backups/</code> &amp; run <code>abr restore</code>, which asks for its passphrase, or decrypt it via <code>gpg -d ${escape(quote(share.name))} &gt; ${escape(quote(share.name.replace(/\.gpg$/, '')))}</code>.</p>
</body>
</html>
`;
}
