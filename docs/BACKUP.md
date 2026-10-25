# Life SQLite backup, restore, upgrade, and rollback

Life stores all durable state in one SQLite database (default
`$DSH_HOME/amadeus-life/life.sqlite`). This procedure is for the isolated
Desktop test profile; never run it against production without an authorized
maintenance window. The GUI's **Advanced & diagnostics → Backup** button creates
a consistent snapshot; restore is intentionally a CLI operation because the
plugin must be stopped before replacing the database.

## 1. Create and verify a backup

From the plugin repository:

```powershell
node scripts/life-backup.mjs backup --database "$env:DSH_HOME\amadeus-life\life.sqlite"
```

The default output is `<data-dir>\backups\life-backup-<UTC>.sqlite` plus a
`.json` metadata sidecar. The command uses SQLite `VACUUM INTO`, so committed WAL
content is included. It prints the file name, bytes, schema version, row counts,
and SHA-256. Existing files are never overwritten.

Verify without changing anything:

```powershell
node scripts/life-backup.mjs verify --file "<backup.sqlite>"
node scripts/life-backup.mjs list --dir "$env:DSH_HOME\amadeus-life\backups"
```

Validation checks SQLite integrity, schema version `9`, required tables, and
emits a SHA-256. Validation is performed on a private read-only copy, so it does
not create or change `-wal`/`-shm`/`-journal` beside the user's file. A malformed
or wrong-schema file is rejected.

## 2. Stop Life

Disable the Life bundle/row in DSH Plugin Manager and wait for its worker to
stop. Do not restore while the plugin is running or while SQLite is being
written.

## 3. Restore with preflight and atomic replacement

Always dry-run first; it validates the backup and target state without writing:

```powershell
node scripts/life-backup.mjs restore --backup "<backup.sqlite>" `
  --database "$env:DSH_HOME\amadeus-life\life.sqlite" --dry-run
```

Then restore:

```powershell
node scripts/life-backup.mjs restore --backup "<backup.sqlite>" `
  --database "$env:DSH_HOME\amadeus-life\life.sqlite"
```

The command:

1. rejects a backup that is the same file as the target through a relative alias,
   symlink, or hardlink;
2. verifies the backup again;
3. copies it to a temporary file beside the target and verifies the copy;
4. moves the current database and any `-wal`/`-shm` aside to
   `life.sqlite.pre-restore-<UTC>...` (never deletes them);
5. atomically renames the verified copy into place;
6. verifies the installed target; if that verification fails, moves the failed
   target and its sidecars to `life.sqlite.failed-restore-<UTC>...` and restores
   the old DB/WAL/SHM before reporting the error;
7. reports the previous path and the restored SHA-256.

If the final rename fails, the command attempts to put the previous files back
and reports the error. Inspect `life.sqlite.pre-restore-*` before deleting
anything.

## 4. Re-enable and validate

Re-enable the Life row, open **Settings → Amadeus Life**, and check Health,
Schema `9`, intents/activities counts, bindings, and a harmless action. If the
database fails validation, stop the plugin and restore the preserved
`pre-restore` files.

## 5. Upgrade and rollback the plugin

1. Back up the database as above.
2. In Plugin Manager, uninstall the old Life bundle/row (this does not delete the
   SQLite file).
3. Install the new versioned tarball (for example
   `dist/amadeus-life-1.0.0.tgz`) through the normal administrator install path.
4. Keep the old tarball and database backup until acceptance completes.

Rollback:

1. Back up the current database.
2. Uninstall the new bundle.
3. Install the prior tarball.
4. Restore the database backup made before the upgrade using the same dry-run
   and restore commands.
5. Re-enable and check Health/Schema. Downgrading a schema that has already been
   migrated is not automatic; restore the pre-upgrade snapshot instead of
   editing tables by hand.

## Limits

- Restore requires the plugin to be stopped; the GUI cannot safely swap SQLite
  while it is serving.
- The backup contains private Life data. Do not copy it into the package,
  repository, public release, or a shared location.
- No backup/restore command reads credentials or contacts a platform.
