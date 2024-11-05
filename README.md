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

`#ABR` is powerful CLI tool for managing backups and restores of your Appwrite instance.\
The package provides an easy and reliable way to back up all Appwrite data, including volumes and configurations, and
restore them as needed.

## Installation

Install the CLI tool globally using `npm`:

```npm
npm install -g @itznotabug/abr
```

## Usage

1. Head to the directory where you ran your previous Appwrite install command.
    ```text
    parent_directory <= you run the command in this directory
    └── appwrite
        └── docker-compose.yml
    ```

2. Run the following command:
    ```shell
    abr backup | restore # or abr --help
    ```

    * Use `abr backup` to create a complete backup of your Appwrite instance.
    * Use `abr restore` to select a backup file and restore your Appwrite instance.

## Considerations

1. **Downtime During Restores**:\
   Restores require Appwrite services to be reinstalled and set up anew, leading to temporary downtime. Plan accordingly
   to minimize disruption, especially for production environments.


2. **Cross Server Restores**:\
   If you backed up an Appwrite instance running on `https://abc.com` but later restore it on   `https://xyz.com`, make
   sure to update your `.env` file accordingly and perform a restart via `docker compose up -d`!


3. **Edge Cases**:\
   Not all machines, environments, and Docker setups are identical. Some configurations might behave differently,
   especially if you're using tools like `Portainer`, `Coolify` or something other. `#ABR` is primarily tested on a
   standard Docker setup.

## Support the Project

Give the project a ⭐️ to show your support!