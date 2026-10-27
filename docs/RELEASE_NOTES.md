# Amadeus Life release notes

## 1.0.1 — 2026-10-27

Patch release for the external-message wake guidance and provenance repair.

- New flat administrator field `externalMessageSessionIds` (default `[]`; every entry must also appear in `allowedSessionIds`). An empty list means every wake prompt keeps the non-sending boundary.
- Opt-in guidance is derived from the persisted current intent's tool provenance (`authorizationRef = life-tool:session:<targetSessionId>`), not from the wake row or the Session binding authorization string. Idle wakes and administrator-created intents remain prohibited; intent lookup errors, missing/revoked intents, and data disagreement fail closed.
- This option changes only the wake prompt. It grants no QQ permission; the downstream QQ Scene allowlist and tool authorization remain hard boundaries.
- 24 volatile flat Config fields. Existing flat fields/defaults, the setup flow, and legacy programmatic nested config compatibility are preserved.
- Install `dist/amadeus-life-1.0.1.tgz` as a distinct versioned artifact. In isolated QA, reinstalling an updated tarball at the same plugin path did not replace the already-installed 1.0.0; verify the installed version and files, then restart/reload the plugin before testing behavior.
- Isolated official DSH/QQ evidence: [QQ external wake verification, 2026-10-27](verification/QQ_EXTERNAL_WAKE_2026-10-27.md). No npm publish, production deployment, or production profile change is included.

### Release checklist (1.0.1)

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.0.1.tgz -Algorithm SHA256
```

## 1.0.0 — historical release

### Product surface

- Native DSH Settings navigation entry **Amadeus Life**, built as a lazy browser module (`./client`).
- One authoritative Config schema shared by the Settings page and Plugin Manager form: 23 volatile fields covering autonomous wake, allowlist, idle, budget, activity tools, shared read, bootstrap, tick/batch, database path, and quiet hours. Volatility is required by DSH `dsh-settings` to serve the namespace; runtime apply is restart-scoped and explicitly labeled.
- First-run wizard for Core only / Autonomous wake / Local activity; explicit admin `bootstrap` creates a stable Persona and private Scene/binding per Session, idempotently, and fails closed on conflicting identity.
- Overview, Session/permission management, intent creation/review/cancel, local activity start/pause/resume/cancel, attention yield, budget reservations, and diagnostics.
- Consistent SQLite snapshot backup from the GUI/CLI; verified dry-run and atomic restore with preserved pre-restore files (see `BACKUP.md`).
- Owner-authenticated same-origin admin API under `/api/amadeus-life`; browser code never opens SQLite. Writes require the Life marker header.
- Versioned tarball, SHA-256 metadata, backup/upgrade/rollback guidance, and user guide.

### Security / defaults

- Autonomous wake, idle, activity tools, shared read, and bootstrap are off by default.
- The GUI cannot mark a Provider activity completed; only trusted Provider evidence can do that.
- Life does not enumerate Sessions; allowlist ids must be entered explicitly.
- No external Provider, payment, publish, deploy, or platform messaging.
- No high-frequency model calls or additional Agent loop.

### Schema / compatibility

- `LIFE_SCHEMA_VERSION = '9'`; v2–v8 migrate incrementally, preserving rows and history.
- Host wake/activity/budget APIs remain independent of the new GUI.
- The client is optional: if Settings/webServer is absent, the Host plugin still runs and health reports delivery degradation where applicable.

### Release / install checklist (1.0.0)

```powershell
npm run build
npm test
npm run package
Get-FileHash dist/amadeus-life-1.0.0.tgz -Algorithm SHA256
```

Install the tarball only through Plugin Manager in an isolated DSH Profile,
then complete the first-run flow in **Settings → Amadeus Life**. Back up the
database before upgrades; restore only while the plugin is stopped. The package
is private/`UNLICENSED`; no public release, license choice, publish, or
production deployment is made by these commands.

### Known limitations (1.0.0)

- Real DSH GUI installation and browser interaction must be verified by Codex; local tests compile the client and exercise registration/API contracts, not pixels.
- The admin API requires DSH `connection.admit` owner admission; older DSH versions without it leave the page disconnected.
- Real payment, external Provider, platform delivery, and production migration authorization are not implemented.
- `node --test` may hit the Windows sandbox `spawn EPERM`; use direct test files and `npm test` locally.
