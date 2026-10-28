# Upgrade, backup, and rollback

## Before any upgrade

1. While Life is running, create a consistent snapshot with the GUI **Back up now** button, then stop/disable the Life row and wait for its worker to stop. Alternatively, stop Life first and run `node scripts/life-backup.mjs backup --database <path>`.
2. Run `verify` on the backup and record its SHA-256, current package version, and tarball SHA-256. Do not copy only `life.sqlite` while WAL is active; use the snapshot flow in [BACKUP](BACKUP.md).
3. Keep the prior tarball and backup available for rollback.

## Install a new tarball (ordinary Desktop flow)

1. Open Plugin Manager → **Add plugin**.
2. Enter the local versioned tarball `dist/amadeus-life-1.1.0.tgz` (or a newer `dist/amadeus-life-<version>.tgz`) path and install. Use a distinct versioned artifact: in isolated QA, reinstalling an updated tarball at the same installed path did not replace the existing 1.0.0.
3. Verify Plugin Manager reports the expected installed version and files. If it still reports the prior version, remove the old package and install the new tarball instead of reusing the same path.
4. Enable the new **Amadeus Life** row and restart/reload the plugin.
5. Open Settings → Amadeus Life, check Health/Schema, and perform a harmless save/restart check.
6. Keep the prior package and DB snapshot until acceptance finishes.

On activation, `LIFE_SCHEMA_VERSION` v10 is verified. v2/v3/v4/v5/v6/v7/v8/v9 databases migrate through the existing incremental transactions; a failed migration rolls back to its source version and reports `LIFE_STORAGE`. Business rows are preserved. A failure never replaces the database with an empty one.

## Rollback

1. Stop/disable the plugin in Plugin Manager.
2. Uninstall the new package and install the prior tarball through the same Plugin Manager flow.
3. Restore the database snapshot with the dry-run/atomic restore commands in [BACKUP](BACKUP.md); the old database is preserved as `life.sqlite.pre-restore-*`.
4. Re-enable and reopen Settings → **Amadeus Life**; check Health/Schema, counts, bindings, and one safe action.

Downgrading below a schema already migrated is not automatic. Restore the pre-upgrade backup instead of deleting tables or editing SQLite.

## First-run changes

The generated presets include explicit `bootstrapEnabled`. If a Session already has a different Persona/Scene binding, activation fails closed with `setup.state: 'failed'`; no binding is changed. Keep the existing binding or use a new DSH Session.

## v1.1 Workspace migration

1. Back up the v9 database and keep the 1.0.x tarball. Life also takes an automatic consistent pre-migration snapshot (`backups/life-pre-v9-*.sqlite`) on first open; it verifies integrity and `schema_version` and aborts without schema writes if the snapshot cannot be created or verified.
2. Install 1.1.0; schema v9 migrates additively to v10 (`life_workspace`, `session_rules`). Existing intents, activities, allowlists, budgets, and wake ledger are unchanged.
3. Open **Settings → Amadeus Life → Workspace** and bind the official Workspace. Binding does not widen autonomous wake; the legacy allowlist remains effective.
4. Explicitly press **Explicitly enable workspace-wide wake** after reviewing the notice. This is the only migration step that expands wake eligibility to inherited/independent current and future members. It does not grant QQ send permission and does not replay old wakes.
5. Configure per-Session `passive`, `independent`, or `disabled` rules. Removing a Session from the Workspace revokes eligibility at the next resolution.
6. If Persona/Scene conflicts are reported, stop and use a new Session or preserve the existing binding; do not delete history.

Rollback restores the v9 snapshot with `node scripts/life-backup.mjs restore --backup <v9-snapshot> --database <path> --dry-run`, followed by the same command without `--dry-run` while Life is stopped. The verifier and restore tool also accept the automatic `life-pre-v9-*.sqlite` snapshot. Do not downgrade a migrated database in place.

## Package verification

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.1.0.tgz -Algorithm SHA256
```

`dist/life-package.json` records the version, tarball, and SHA-256. `npm run package` is local only; it does not publish, install, or touch a profile. The tarball includes Host, built Client, Config/schema, locale, icon, docs, scripts, and tests; it contains no SQLite/WAL/data files.
