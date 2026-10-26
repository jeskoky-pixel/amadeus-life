# Upgrade, backup, and rollback

## Before any upgrade

1. Stop/disable the Life row in the isolated DSH Profile; wait for the worker to stop.
2. Create a consistent snapshot with the GUI **Back up now** button or `node scripts/life-backup.mjs backup --database <path>`. Do not copy only `life.sqlite` while WAL is active; use the snapshot flow in [BACKUP](BACKUP.md).
3. Run `verify` on the backup and record its SHA-256, current package version, and tarball SHA-256.
4. Keep the prior tarball and backup available for rollback.

## Install a new tarball (ordinary Desktop flow)

1. Open Plugin Manager → **Add plugin**.
2. Enter the local versioned tarball `dist/amadeus-life-1.0.1.tgz` (or a newer `dist/amadeus-life-<version>.tgz`) path and install. Use a distinct versioned artifact: in isolated QA, reinstalling an updated tarball at the same installed path did not replace the existing 1.0.0.
3. Verify Plugin Manager reports the expected installed version and files. If it still reports the prior version, remove the old package and install the new tarball instead of reusing the same path.
4. Enable the new **Amadeus Life** row and restart/reload the plugin.
5. Open Settings → Amadeus Life, check Health/Schema, and perform a harmless save/restart check.
6. Keep the prior package and DB snapshot until acceptance finishes.

On activation, `LIFE_SCHEMA_VERSION` v9 is verified. v2/v3/v4/v5/v6/v7/v8 databases migrate through the existing incremental transactions; a failed migration rolls back to its source version and reports `LIFE_STORAGE`. Business rows are preserved. A failure never replaces the database with an empty one.

## Rollback

1. Stop/disable the plugin in Plugin Manager.
2. Uninstall the new package and install the prior tarball through the same Plugin Manager flow.
3. Restore the database snapshot with the dry-run/atomic restore commands in [BACKUP](BACKUP.md); the old database is preserved as `life.sqlite.pre-restore-*`.
4. Re-enable and reopen Settings → **Amadeus Life**; check Health/Schema, counts, bindings, and one safe action.

Downgrading below a schema already migrated is not automatic. Restore the pre-upgrade backup instead of deleting tables or editing SQLite.

## First-run changes

The generated presets include explicit `bootstrapEnabled`. If a Session already has a different Persona/Scene binding, activation fails closed with `setup.state: 'failed'`; no binding is changed. Keep the existing binding or use a new DSH Session.

## Package verification

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.0.1.tgz -Algorithm SHA256
```

`dist/life-package.json` records the version, tarball, and SHA-256. `npm run package` is local only; it does not publish, install, or touch a profile. The tarball includes Host, built Client, Config/schema, locale, icon, docs, scripts, and tests; it contains no SQLite/WAL/data files.
