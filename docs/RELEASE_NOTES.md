# Amadeus Life release notes

## 1.2.0 internal release candidate (not publicly released)

- Align `@amadeus/life@1.2.0` while preserving the `amadeus-life` Bundle ID, workspace binding, activities, intents, wake rules and budgets. This release focuses on packaging and upgrade safety.
- Ship a prebuilt Client, Bundle Manifest, market assets and migration guidance. An isolated DSH Desktop `0.2.1-rc.3` CLI upgrade from 1.1.0 preserved synthetic data through restart, uninstall and reinstall.
- The owner chose MIT for this repository. v1.2 distribution is planned through a fixed GitHub Release package; `private:true` remains to prevent accidental npm publication.
- Desktop graphical installation, public Market delivery and live autonomous wake/QQ handoff remain unverified. Public distribution awaits release approval.

## 1.1.0 — 2026-10-28

Workspace-scoped Life scheduling and independent console.

- Bind one official DSH Workspace through the GUI. Stable entity id and registry-validated `sessionIds` are the membership source; titles/paths are display-only. Current and late-joining Sessions are included on each resolution; outside/removed Sessions are denied.
- One stable Workspace Persona and binding per member Session. Binding does not widen wake access; workspace-wide autonomous wake requires a separate explicit activation. Legacy 1.0 allowlists remain effective but are not silently expanded. Existing intents, activities, budget, and wake ledger are preserved; activation creates no new wake/delivery.
- Per-Session modes: inherit, passive, independent, disabled. Passive never gets autonomous wake; disabled denies Life tool/context/wake and conservatively pauses/unknowns activities. Independent wake/token/activity limits are clamped below global budget and use the shared resource lock.
- GUI adds a Workspace page for binding, explicit activation and session-rule editing; existing Settings entry/overview remains.
- SQLite schema v10 adds workspace binding/activation markers and durable session rules. v2–v9 migrate additively; backup before upgrade and use the documented dry-run/atomic restore for rollback.
- `externalMessageSessionIds` remains a separate default-empty prompt opt-in; no QQ send permission is granted. State is optional and absent-safe.
- Validation: deterministic tests cover registry membership/late join/removal, legacy non-widening, stable Persona/restart, modes, independent/global limits, owner API, GUI/bundle registration, backup/restore, and prior v1 behavior. Isolated DSH GUI and four-plugin checks are recorded in the [joint report](https://github.com/jeskoky-pixel/amadeus-qq/blob/main/docs/verification/FOUR_PLUGIN_V11_JOINT_2026-10-28.md); real NapCat/Life external-delivery acceptance remains open.

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
