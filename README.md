# #ABR - Appwrite Backup Restore

A powerful CLI tool for managing backups and restores of your Appwrite instance.\
`#ABR` provides an easy and reliable way to back up all Appwrite data, including volumes and configurations, and restore
them as needed.

> [!NOTE]
> This product is still in testing phase and is not released on NPM yet.

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

1. **Downtime During Backups**:\
   Backups require the Appwrite services to be stopped, which will result in a temporary downtime. Please account for
   this
   downtime based on the size of your databases and the projects you are backing up, as larger databases may take longer
   to process.


2. **Downtime During Restores**:\
   Restores require Appwrite services to be reinstalled and set up anew, leading to temporary downtime. Plan accordingly
   to minimize disruption, especially for production environments.


3. **Cross Server Restores**:\
   If you backed up an Appwrite instance running on `https://abc.com` but later restore it on   `https://xyz.com`, make
   sure to update your `.env` file accordingly and perform a restart via `docker compose up -d`!


4. **Edge Cases**:\
   Not all machines, environments, and Docker setups are identical. Some configurations might behave differently,
   especially if you're using tools like `Portainer`, `Coolify` or something other. `#ABR` is primarily tested on a
   standard Docker setup.

### Why the downtimes?

If Appwrite services are running and actively modifying data during a backup, there's a risk of capturing an
inconsistent state. For example, the database might be in the middle of a transaction when the backup is made, which
could lead to data corruption or inconsistencies in the backup.

For best results, it's recommended to schedule routine maintenance windows to perform backups and restores with minimal
disruption.

## Support the Project

Give the project a ⭐️ to show your support!