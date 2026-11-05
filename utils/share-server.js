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

    // browsers get the error pages as HTML.
    const html = /text\/html/.test(request.headers.accept ?? '');
    const reply = (code, text, headers) =>
        send(response, code, text, headers, html);

    // unknown paths look the same with or without credentials.
    const parts = request.url.split('?')[0].split('/');
    if (parts.length === 2 && safeEqual(parts[1], share.probe)) {
        return send(response, 200, ['OK.']);
    }
    const notFound = [
        'Link not found',
        'Check that the link is complete, or ask the sender for it again.',
    ];
    if (parts.length > 3 || !safeEqual(parts[1], share.token)) {
        return reply(404, notFound);
    }
    if (share.expired) {
        return reply(410, [
            'Link expired',
            'This backup is no longer shared. Ask the sender for a new link.',
        ]);
    }
    if (!safeEqual(basicCredentials(request), share.credentials)) {
        return reply(
            401,
            [
                'Password needed',
                'Sign in with the user "abr" & the password from the sender.',
            ],
            { 'WWW-Authenticate': 'Basic realm="abr", charset="UTF-8"' },
        );
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        return reply(405, ['Method not allowed', 'Use GET or HEAD.'], {
            Allow: 'GET, HEAD',
        });
    }

    if (parts.length === 2) {
        return reply(308, ['Moved', 'The page moved.'], {
            Location: `/${share.token}/`,
        });
    }
    if (parts[2] === '') {
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': pagePolicy,
        });
        return response.end(request.method === 'HEAD' ? '' : page(share));
    }
    if (parts[2] !== encodeURIComponent(share.name)) {
        return reply(404, notFound);
    }

    download(request, response, share, log);
}

function send(response, code, text, headers = {}, html = false) {
    response.writeHead(code, {
        'Content-Type': `text/${html ? 'html' : 'plain'}; charset=utf-8`,
        ...(html && { 'Content-Security-Policy': pagePolicy }),
        ...headers,
    });
    response.end(html ? errorPage(...text) : `${text.join(' ')}\n`);
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
        return send(response, 416, ['Range not satisfiable.'], {
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

const styles = `
:root { --pink: #fd366e; --bg: #f4f4f7; --card: #fff; --text: #19191c; --muted: #6c6c71; --line: #e8e8ec; --code: #f6f6f8; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #19191c; --text: #ededf0; --muted: #97979b; --line: #2d2d31; --code: #222226; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; display: grid; place-items: center; padding: 2rem 1rem; }
main { width: 100%; max-width: 44rem; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: clamp(1.25rem, 4vw, 2rem); }
header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.25rem; margin: 0; flex: 1; }
.badge { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; color: var(--pink); border: 1px solid var(--pink); border-radius: 999px; padding: 0.15rem 0.6rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.45rem 1.25rem; margin: 0 0 1.75rem; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.download { display: block; text-align: center; background: var(--pink); color: #fff; font-weight: 600; text-decoration: none; padding: 0.85rem; border-radius: 10px; }
.download:hover { background: #e92d62; }
.notice { margin: 0; padding: 0.85rem 1rem; border-radius: 10px; border: 1px solid var(--line); background: var(--code); color: var(--muted); }
h2 { font-size: 0.95rem; margin: 1.75rem 0 0.4rem; display: flex; align-items: center; gap: 0.5rem; }
h2 span { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; background: var(--pink); color: #fff; font-size: 0.75rem; }
p { margin: 0 0 0.6rem; color: var(--muted); }
p code { color: var(--text); }
.cmd { display: flex; align-items: center; gap: 0.5rem; background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 0.4rem 0.4rem 0.4rem 0.85rem; }
.cmd pre { flex: 1; min-width: 0; margin: 0; padding: 0.35rem 0; white-space: pre; overflow-x: auto; }
.cmd button { flex: none; font: 12px system-ui, sans-serif; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 0.25rem 0.65rem; cursor: pointer; }
.cmd button:hover { border-color: var(--muted); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--pink); outline-offset: 2px; }
footer { margin-top: 1.75rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 0.8rem; color: var(--muted); }
`;

/**
 * Shows the expiry in the visitor's time & swaps the download for a notice once it passed. Copies commands.
 */
const script = `
// from the time left when served, the visitor's clock may be off.
const time = document.querySelector('time');
const deadline = new Date(Date.now() + Number(time.dataset.left));
const at = deadline.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const tick = () => {
    const minutes = Math.ceil((deadline - Date.now()) / 60000);
    if (minutes > 0) {
        time.textContent = (minutes === 1 ? 'in a minute' : 'in ' + minutes + ' minutes') + ', at ' + at;
        return;
    }
    time.textContent = 'expired at ' + at;
    document.querySelector('.download').outerHTML = '<p class="notice">This link has expired. Ask the sender for a new one.</p>';
    document.querySelector('.steps').remove();
    clearInterval(timer);
};
const timer = setInterval(tick, 15000);
tick();
document.querySelectorAll('[data-copy]').forEach((button) =>
    button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(button.previousElementSibling.textContent);
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
    }),
);
`;

/**
 * The only script pages may run, by its hash in the Content-Security-Policy.
 */
const pagePolicy = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`;

const lock = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function escape(text) {
    return String(text).replace(
        /[&<>"']/g,
        (char) => `&#${char.charCodeAt(0)};`,
    );
}

function layout(title, body, withScript = false) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${styles}</style>
</head>
<body>
<main>
${body}
</main>${withScript ? `\n<script>${script}</script>` : ''}
</body>
</html>
`;
}

/**
 * A short error page in the share's style, for browsers.
 */
function errorPage(title, message) {
    return layout(
        title,
        `<header><h1>${escape(title)}</h1></header>\n<p>${escape(message)}</p>\n<footer>Shared with ABR.</footer>`,
    );
}

function page(share) {
    const name = escape(share.name);
    const deadline = new Date(share.deadline);
    const command = (text) =>
        `<div class="cmd"><pre>${escape(text)}</pre><button type="button" data-copy>Copy</button></div>`;
    return layout(
        `Appwrite backup · ${share.name}`,
        `<header>
<h1>Appwrite backup</h1>
<span class="badge">${lock}Encrypted</span>
</header>
<dl>
<dt>File</dt><dd><code>${name}</code></dd>
<dt>Size</dt><dd>${escape(formatSize(share.size / 1024))}</dd>
<dt>Expires</dt><dd><time datetime="${deadline.toISOString()}" data-left="${Math.max(0, share.deadline - Date.now())}">${escape(deadline.toUTCString())}</time></dd>
<dt>SHA-256</dt><dd><code>${share.sha256}</code></dd>
</dl>
<a class="download" href="${escape(encodeURIComponent(share.name))}" download>Download backup</a>
<div class="steps">
<h2><span>1</span>Or download with curl</h2>
<p>Asks for the password & resumes if the connection drops.</p>
${command(curlCommand(share))}
<h2><span>2</span>Check the download</h2>
${command(`echo ${quote(`${share.sha256}  ${share.name}`)} | shasum -a 256 -c`)}
<h2><span>3</span>Restore it</h2>
<p>Put it in <code>backups/</code> next to your <code>appwrite/</code> folder, then run <code>abr restore</code> & enter the backup's passphrase. Or decrypt it yourself:</p>
${command(`gpg -d ${quote(share.name)} > ${quote(share.name.replace(/\.gpg$/, ''))}`)}
</div>
<footer>Shared with ABR. The password & passphrase come from the sender, separately from this link.</footer>`,
        true,
    );
}
