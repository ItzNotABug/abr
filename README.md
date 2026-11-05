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

Back up, restore & share your self-hosted Appwrite instance from the command line.

Supports Appwrite 1.8.x & 1.9.x, with MariaDB or MongoDB. Appwrite 2.x & PostgreSQL aren't supported yet.

## Installation

Needs Node.js 20.5+ & Docker with Compose. This README describes the `beta` release:

```shell
npm install -g @itznotabug/abr@beta
```

## Usage

Run `abr` from the folder that holds your `appwrite` folder. Backups go to `backups`, next to it.

```text
parent_directory <= run abr here
├── appwrite
│   ├── docker-compose.yml
│   └── .env
└── backups
```

| Command                 | What it does                                             |
|-------------------------|----------------------------------------------------------|
| `abr backup`            | Asks for a backup type & creates a backup.               |
| `abr backup --encrypt`  | The same, encrypted with a passphrase.                   |
| `abr restore`           | Asks for a backup & replaces the current install with it. |
| `abr share`             | Shares an encrypted backup via a temporary link.         |

## Backup Types

| Type     | Appwrite during the backup | Database                                                    |
|----------|----------------------------|-------------------------------------------------------------|
| Hot      | Keeps running              | Snapshot via `mariadb-backup`, or `mongodump --oplog`       |
| Semi-hot | Paused                     | Volume copy                                                 |
| Cold     | Stopped, then restarted    | Volume copy                                                 |

- Hot backups need a running database, and copy uploads & other files live.
- To back up a stopped install & leave it stopped, use semi-hot. Cold starts it again.
- Backups include Appwrite's volumes, `.env`, `docker-compose.yml` & the files the database mounts from `appwrite`.
- The `appwrite-models` cache isn't backed up, it's downloaded again. Volumes you added aren't either, ABR warns about
  them.

## Restoring

`abr restore` reads the whole backup first, then lists what it will remove & asks you to confirm.\
It removes the install's containers, volumes & `appwrite` folder, so Appwrite is down during the restore.

If the instance moves to another domain, update `.env` & run `docker compose up -d` in `appwrite`.

## Encryption

`abr backup --encrypt` asks for a passphrase, or reads `ABR_GPG_PASSPHRASE`. A lost passphrase can't be recovered.\
`abr restore` asks for it too. You can also decrypt a backup yourself via `gpg -d`.

## Sharing

`abr share` serves an encrypted backup through a [Cloudflare Quick Tunnel](https://try.cloudflare.com). It needs no
account, domain or Docker.

```shell
abr share --expires 1h # 15m by default, up to 24h
```

It prints a link, a password shown only once & the backup's SHA-256. The link's page has the download, plus `curl`,
checksum & restore commands. Press `Ctrl+C` to stop early.

Only encrypted backups can be shared, as Cloudflare can read the traffic through its tunnel. Send the password &
passphrase separately from the link.

## Limitations

- Backups ask for their type in a terminal, so scheduled backups aren't supported yet.
- Only the default `appwrite` Compose project is supported.
- ABR is tested on standard Docker setups. Tools like Portainer or Coolify may behave differently.

## Support the Project

Give the project a ⭐️ to show your support!
