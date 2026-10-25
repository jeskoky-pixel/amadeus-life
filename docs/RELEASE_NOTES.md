# Amadeus Life 1.0.0 release notes

## Product surface

- Native DSH Settings navigation entry **Amadeus Life**, built as a lazy browser module (`./client`).
- One authoritative Config schema shared by the Settings page and Plugin Manager form: 23 volatile fields covering autonomous wake, allowlist, idle, budget, activity tools, shared read, bootstrap, tick/batch, database path, and quiet hours. Volatility is required by DSH `dsh-settings` to serve the namespace; runtime apply is restart-scoped and explicitly labeled.
- First-run wizard for Core only / Autonomous wake / Local activity; explicit admin `bootstrap` creates a stable Persona and private Scene/binding per Session, idempotently, and fails closed on conflicting identity.
- Overview, Session/permission management, intent review/cancel, activity pause/resume/cancel, budget reservations, and diagnostics.
- Owner-authenticated same-origin admin API under `/api/amadeus-life`; browser code never opens SQLite. Writes require the Life marker header.
- Versioned tarball, SHA-256 metadata, backup/upgrade/rollback guidance, and user guide.

## Security / defaults

- Autonomous wake, idle, activity tools, shared read, and bootstrap are off by default.
- The GUI cannot mark a Provider activity completed; only trusted Provider evidence can do that.
- Life does not enumerate Sessions; allowlist ids must be entered explicitly.
- No external Provider, payment, publish, deploy, or platform messaging.
- No high-frequency model calls or additional Agent loop.

## Schema / compatibility

- `LIFE_SCHEMA_VERSION = '9'`; v2–v8 migrate incrementally, preserving rows and history.
- Host wake/activity/budget APIs remain independent of the new GUI.
- The client is optional: if Settings/webServer is absent, the Host plugin still runs and health reports delivery degradation where applicable.

## Known limitations

- Real DSH GUI installation and browser interaction must be verified by Codex; local tests compile the client and exercise registration/API contracts, not pixels.
- The admin API requires DSH `connection.admit` owner admission; older DSH versions without it leave the page disconnected.
- Real payment, external Provider, platform delivery, and production migration authorization are not implemented.
- `node --test` may hit the Windows sandbox `spawn EPERM`; use direct test files and `npm test` locally.
