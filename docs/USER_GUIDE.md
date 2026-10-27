# Amadeus Life 1.0.1 — User Guide

Amadeus Life is a DSH Desktop plugin for durable intents, activities, optional autonomous wake/idle, budgets, and diagnostics. It does **not** send platform messages, run a second Agent, or perform payments.

## Install and open

1. In DSH Plugin Manager, choose **Add plugin**, enter/paste the local versioned tarball path `dist/amadeus-life-1.0.1.tgz`, install, and enable the resulting **Amadeus Life** row. Use a distinct versioned artifact: reinstalling an updated tarball at the same installed path may not replace an earlier version. Do not hand-edit a production profile.
2. Verify Plugin Manager reports version 1.0.1 and the expected files, then restart/reload the plugin. A Host 200 alone is not enough; verify the page and console.
3. Open **DSH Settings**. The left navigation contains **Amadeus Life / Amadeus 生活**. The label follows the browser UI language (Chinese is preferred when available).
4. The page works while the plugin is active; if the Host settings API is unavailable, it shows a clear disconnected/error state instead of pretending data exists.

To disable/re-enable later, use the same Plugin Manager switch. Disabling stops timers and closes SQLite but keeps the database; re-enabling with the same config restores the durable intents, activities, budgets, and bindings. Uninstalling the package does not delete the database.

## First run (no manual JSON)

On **First run** choose one mode:

- **Core only** — intents/activities/health; no autonomous wake, idle, new activity tools, or identity bootstrap.
- **Autonomous wake** — due/idle wake only for the Session ids you enter; default persistent budget; local bootstrap creates the default identity.
- **Local activity** — local virtual Provider tools; Host wake remains off; local bootstrap creates the default identity.

Paste valid DSH Session ids (one per line or comma separated), apply the preset to the draft, then **Save settings**. You may also press **Create default identity now** to bootstrap immediately.

Bootstrap creates one stable Persona, one **private** Scene per allowlisted Session, and one binding per Session. Reapplying the same config does nothing and does not increase binding revisions. If a Session already has a different Persona/Scene, setup fails closed and the page shows the conflict; Life never overwrites history. Use the existing binding or a new Session.

All authoritative fields are volatile Config forms so DSH serves the `amadeus-life` Settings namespace and Plugin Manager config surface. The Host runtime reads those references, but wake/idle/budget/tool construction is restart-scoped: after saving, restart/reload the plugin before expecting runtime behavior to change. The page and basic config card state this explicitly; they never display pre-restart behavior as already applied.

## Pages

- **Overview** — health, setup state, intent/activity counts, wake-policy summary, recent wakes and errors.
- **First run** — safe presets, Session allowlist, common options.
- **Sessions & permissions** — configured allowlist and bindings; **Yield to user** for attention; explicit revoke. Life does not enumerate or invent Sessions.
- **Intents** — create a durable intent for an authorized Session, choose a review time, and cancel with revision CAS.
- **Activities** — start a local virtual activity, then status/pause/resume/cancel through the Provider boundary. The GUI never marks a running Provider activity completed.
- **Budget** — wake/token/cost reservations and activity concurrency. Cost is a trusted reservation ledger; no payment Provider is installed.
- **Advanced & diagnostics** — tick/batch/database/quiet-hour fields, schema/health, database location, and **Back up now** (consistent snapshot; restore is a stopped-plugin CLI flow). Editing the DB path requires restart.

## Validation and feedback

- Every field shows its default, allowed range, and unit where applicable.
- Invalid numbers, strings, arrays, Session ids, and cross-field combinations are highlighted with a specific reason; **Save** is disabled only while a visible validation error exists.
- **Save**, **Cancel**, and **Restore defaults** are available with conflict feedback. Restore defaults only unsets configuration; it never deletes intents, activities, bindings, budgets, or history.
- Revoke, intent cancel, activity cancel, attention yield, and restore defaults ask for confirmation where they change runtime state.
- Focus rings, disabled/loading/error states, scrollable tables, and a narrow-window layout are supported; no credential or database content is sent to the model.

## Saving

- Changes are staged; **Save settings** commits the same authoritative Config used by Plugin Manager.
- **Cancel** discards the local draft; **Restore defaults** unsets fields but never deletes intents, activities, budgets, or history.
- A revision conflict is shown explicitly; reload the latest values or keep your draft and save again.
- Errors are shown in the page. Common health reasons: `disabled`, `awaiting_services`, `missing_capability`, `reconciliation_unavailable`, `bootstrap_failed`.

## Backup, upgrade, rollback

Back up the database (and any `-wal`/`-shm` files) before upgrading. Use the GUI **Back up now** button for a consistent snapshot, or the CLI commands in [BACKUP](BACKUP.md). v2–v8 databases are migrated incrementally to v9; no database is reset or replaced. Roll back by reinstalling the prior package and restoring the backed-up database with the documented dry-run/atomic restore flow. See [BACKUP](BACKUP.md) and [UPGRADE](UPGRADE.md).

## Boundaries

- Autonomous delivery and local activity/shared tools are off by default.
- The flat `externalMessageSessionIds` field defaults to empty (all wakes non-sending) and must be a subset of `allowedSessionIds`. Non-empty guidance applies only to a wake whose persisted current intent has model-tool provenance; idle wakes and administrator-created intents remain prohibited. It changes only the wake prompt and grants no QQ permission; the downstream QQ Scene allowlist and tool authorization remain authoritative.
- No external Provider, payment, publish, deploy, or platform sender is implemented by Life itself.
- The settings API is owner-authenticated and same-origin; browser code never opens SQLite.
- The GUI can request cancellation only; terminal Provider state requires trusted Provider evidence.

Version 1.0.1 · schema v9 · DSH Desktop 0.2.1-rc.2 or newer.
