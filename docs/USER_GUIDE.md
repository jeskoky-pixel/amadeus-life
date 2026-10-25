# Amadeus Life 1.0.0 — User Guide

Amadeus Life is a DSH Desktop plugin for durable intents, activities, optional autonomous wake/idle, budgets, and diagnostics. It does **not** send platform messages, run a second Agent, or perform payments.

## Install and open

1. In DSH Plugin Manager, install `dist/amadeus-life-1.0.0.tgz` (or the package directory) through the normal administrator install flow. Do not hand-edit a production profile.
2. Open **DSH Settings**. The left navigation contains **Amadeus Life**.
3. The page works while the plugin is active; if the Host settings API is unavailable, it shows a clear disconnected/error state instead of pretending data exists.

## First run (no manual JSON)

On **First run** choose one mode:

- **Core only** — intents/activities/health; no autonomous wake, idle, new activity tools, or identity bootstrap.
- **Autonomous wake** — due/idle wake only for the Session ids you enter; default persistent budget; local bootstrap creates the default identity.
- **Local activity** — local virtual Provider tools; Host wake remains off; local bootstrap creates the default identity.

Paste valid DSH Session ids (one per line or comma separated), apply the preset to the draft, then **Save settings**. You may also press **Create default identity now** to bootstrap immediately.

Bootstrap creates one stable Persona, one **private** Scene per allowlisted Session, and one binding per Session. Reapplying the same config does nothing and does not increase binding revisions. If a Session already has a different Persona/Scene, setup fails closed and the page shows the conflict; Life never overwrites history. Use the existing binding or a new Session.

All authoritative fields are volatile Config forms so DSH serves the `amadeus-life` Settings namespace and Plugin Manager config surface. The Host runtime reads those references, but wake/idle/budget/tool construction is restart-scoped: after saving, restart/reload the plugin before expecting runtime behavior to change. The page and basic config card state this explicitly; they never display pre-restart behavior as already applied.

## Pages

- **Overview** — health, setup state, Session/intents/activity counts, recent wakes and errors.
- **First run** — safe presets, Session allowlist, common options.
- **Sessions & permissions** — configured allowlist and existing bindings; explicit revoke. Life does not enumerate or invent Sessions, so copy ids from DSH.
- **Intents** — review due-time/status and cancel with revision CAS.
- **Activities** — status and pause/resume/cancel through the Provider boundary. The GUI never marks a running Provider activity completed.
- **Budget** — wake/token/cost reservations and activity concurrency. Cost is a trusted reservation ledger; no payment Provider is installed.
- **Advanced & diagnostics** — tick/batch/database/quiet-hour fields, schema/health, database location. Editing the DB path requires restart.

## Saving

- Changes are staged; **Save settings** commits the same authoritative Config used by Plugin Manager.
- **Cancel** discards the local draft; **Restore defaults** unsets fields but never deletes intents, activities, budgets, or history.
- A revision conflict is shown explicitly; reload the latest values or keep your draft and save again.
- Errors are shown in the page. Common health reasons: `disabled`, `awaiting_services`, `missing_capability`, `reconciliation_unavailable`, `bootstrap_failed`.

## Backup, upgrade, rollback

Back up the database (and any `-wal`/`-shm` files) before upgrading. v2–v8 databases are migrated incrementally to v9; no database is reset or replaced. Roll back by reinstalling the prior package and restoring the backed-up database. See [UPGRADE](UPGRADE.md).

## Boundaries

- Autonomous delivery and local activity/shared tools are off by default.
- No external Provider, payment, publish, deploy, or platform sender is implemented.
- The settings API is owner-authenticated and same-origin; browser code never opens SQLite.
- The GUI can request cancellation only; terminal Provider state requires trusted Provider evidence.

Version 1.0.0 · schema v9 · DSH Desktop 0.2.1-rc.2 or newer.
