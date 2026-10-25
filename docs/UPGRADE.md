# Upgrade, backup, and rollback

## Before any upgrade

1. Stop the Life plugin (or the isolated DSH test instance).
2. Copy the entire Life data directory, including `life.sqlite`, `life.sqlite-wal`, and `life.sqlite-shm`.
3. Record the current package version and tarball SHA-256.
4. Keep the prior tarball available for rollback.

## Install a new tarball

Use DSH Plugin Manager's administrator install/update path for `dist/amadeus-life-<version>.tgz`. Do not edit a production profile by hand and do not run `pnpm` in the profile directory.

On activation, `LIFE_SCHEMA_VERSION` v9 is verified. v2/v3/v4/v5/v6/v7/v8 databases migrate through the existing incremental transactions; a failed migration rolls back to its source version and reports `LIFE_STORAGE`. Business rows are preserved. A failure never replaces the database with an empty one.

## Rollback

1. Stop the plugin.
2. Reinstall the prior package tarball through Plugin Manager.
3. Restore the backed-up SQLite/WAL/SHM files.
4. Reopen Settings → **Amadeus Life** and check Health/Schema.

Downgrading below a schema already migrated is not automatic. Restore the pre-upgrade backup instead of deleting tables or editing SQLite.

## First-run changes

The generated presets include explicit `bootstrap`. If a Session already has a different Persona/Scene binding, activation fails closed with `setup.state: 'failed'`; no binding is changed. Keep the existing binding or use a new DSH Session.

## Package verification

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.0.0.tgz -Algorithm SHA256
```

`dist/life-package.json` records the version, tarball, and SHA-256. `npm run package` is local only; it does not publish, install, or touch a profile. The tarball includes Host, built Client, Config/schema, locale, icon, docs, scripts, and tests; it contains no SQLite/WAL/data files.
