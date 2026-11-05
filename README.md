# #ABR - Appwrite Backup Restore

![GitHub stars](https://img.shields.io/github/stars/ItzNotABug/abr?style=flat)
![GitHub forks](https://img.shields.io/github/forks/ItzNotABug/abr?style=flat)
![GitHub issues](https://img.shields.io/github/issues/ItzNotABug/abr)
![GitHub pull requests](https://img.shields.io/github/issues-pr/ItzNotABug/abr)
![GitHub license](https://img.shields.io/github/license/ItzNotABug/abr)
![GitHub Release](https://img.shields.io/github/v/release/ItzNotABug/abr)
![Source CI](https://img.shields.io/github/actions/workflow/status/ItzNotABug/abr/source-ci.yaml?label=source-build)
![NPM Downloads](https://img.shields.io/npm/dm/@itznotabug/abr)
![Node.js](https://img.shields.io/badge/Node.js-brightgreen?style=flat&logo=node.js&logoColor=white)
![Appwrite](https://img.shields.io/badge/Appwrite-FD366E?style=flat&logo=appwrite&logoColor=white)

A CLI to back up, restore and share your self-hosted Appwrite instance.

Works with Appwrite 1.8.x and 1.9.x, on MariaDB or MongoDB.

## Installation

You'll need Node.js 20.5+ and Docker with Compose. This README is for the beta:

```shell
npm install -g @itznotabug/abr@beta
```

## Usage

Run `abr` from the folder that contains `appwrite`. Backups are saved in a `backups` folder next to it.

```text
parent_directory <= run abr here
├── appwrite
│   ├── docker-compose.yml
│   └── .env
└── backups
```

| Command                | What it does                                          |
|------------------------|-------------------------------------------------------|
| `abr backup`           | Create a backup. You pick the type.                   |
| `abr backup --encrypt` | Same, but encrypted with a passphrase.                |
| `abr restore`          | Pick a backup and replace the current install with it. |
| `abr share`            | Share an encrypted backup through a temporary link.   |

## Backup Types

| Type     | Appwrite during the backup | Database                                       |
|----------|----------------------------|------------------------------------------------|
| Hot      | Keeps running              | `mariadb-backup` snapshot or `mongodump --oplog` |
| Semi-hot | Paused                     | Volume copy                                    |
| Cold     | Stopped, then restarted    | Volume copy                                    |

- Hot needs a running database. Files are copied while Appwrite is live, so uploads made during the backup may not
  match the database.
- If the install is already stopped and should stay that way, use semi-hot. Cold starts it again afterwards.
- A backup has Appwrite's volumes, `.env`, `docker-compose.yml` and any files the database mounts from `appwrite`.
- It leaves out the `appwrite-models` cache, which gets downloaded again, and volumes you added yourself. ABR warns you
  about those.

## Restoring

`abr restore` reads the whole backup first, shows what it will remove and asks before touching anything.\
It then removes the install's containers, volumes and `appwrite` folder, so Appwrite is down until the restore finishes.

Moved to a new domain? Update `.env`, then run `docker compose up -d` in `appwrite`.

## Encryption

`abr backup --encrypt` asks for a passphrase, or takes it from `ABR_GPG_PASSPHRASE`. If you lose it, the backup can't be
recovered.\
`abr restore` asks for it the same way, or you can decrypt the file yourself with `gpg -d`.

## Sharing

`abr share` serves an encrypted backup through a [Cloudflare Quick Tunnel](https://try.cloudflare.com). No account,
domain or Docker needed.

```shell
abr share --expires 1h # 15m by default, up to 24h
```

You get a link, a password (shown only once) and the backup's SHA-256. The link opens a page with a download button and
`curl`, checksum and restore commands. Press `Ctrl+C` to stop sharing early.

Only encrypted backups can be shared, because Cloudflare can read traffic through its tunnel. Send the password and
passphrase separately from the link.

## Limitations

- Backups ask for their type in a terminal, so you can't schedule them yet.
- Only the default `appwrite` Compose project works.
- ABR is tested on standard Docker setups. Portainer, Coolify and similar tools may behave differently.

## Support the Project

Give the project a ⭐️ to show your support!
