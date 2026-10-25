# Life final productization report

Date: 2026-10-25
Scope: the existing `amadeus-life` worktree only. No Git commit/push, no installation into a real profile, no production/DSH/QQ/Memory data, no credentials, no external platform or payment call.

## What changed

### Seven-page GUI and normal-user flows

- Settings page keeps the seven tabs: Overview, First run, Sessions & permissions, Intents, Activities, Budget, Advanced & diagnostics.
- Intents now supports **create** for an authorized Session (description + local review time → UTC ISO) in addition to list/cancel with revision CAS.
- Activities now supports **start** of the local virtual Provider for an authorized Session, in addition to pause/resume/cancel; it never offers a direct “completed” transition.
- Sessions adds **Yield to user** (attention priority) with confirmation and Host-derived Session scope.
- First-run preset labels: the third preset is rendered as **本地活动 / Local activity**; the budget column/chip uses a separate `activityConcurrency` key (**活动并发 / Activity concurrency**). A client render regression checks Chinese and English labels and confirms the preset never shows the budget label.
- Overview shows a wake-policy summary (autonomous on/off, allowlist size, interval, budget, activity limit) with an explicit restart notice.
- Advanced adds **Back up now** and a bounded backup list. Restore is deliberately a stopped-plugin CLI flow.
- Config fields now show default, allowed range, and unit; typed validation covers boolean/number/string/array/enum plus cross-field idle/allowlist/bootstrap/quiet-hour rules. Errors are shown per field and at the top.
- Save/cancel/restore-defaults/conflict feedback is shared with the plugin-detail basic card. Restore defaults only unsets Config values and never invokes data deletion.
- High-risk actions have confirmations: binding revoke, intent cancel, activity cancel, attention yield, restore defaults.
- Existing CSS uses theme variables and a narrow-window media query; focus-visible rings cover buttons/inputs/selects/textareas; tables scroll inside their wrapper, not the page.
- GUI uses the existing owner-authenticated same-origin API; no direct SQLite, no credentials, no Host-permission bypass.

### Backup / restore / upgrade / rollback

- New `src/backup.js` and `scripts/life-backup.mjs`.
  - `backup`: SQLite `VACUUM INTO` consistent snapshot, integrity/schema/table validation, SHA-256, metadata sidecar, never overwrites.
  - `verify`: validation runs on a private read-only temporary copy, so the user's DB and its `-wal`/`-shm`/`-journal` are never created or changed; the source hash/bytes are still reported.
  - `restore`: dry-run preflight; canonical path plus dev/ino identity check rejects `.`/`..`, relative alias, symlink, and hardlink self-restore before any copy; verifies backup and temporary copy; preserves target DB/WAL/SHM as `life.sqlite.pre-restore-*`; atomically installs; verifies installed target. On post-install failure it quarantines the failed target **and its sidecars** as `life.sqlite.failed-restore-*`, then restores the old DB/WAL/SHM. If quarantine/restore itself fails, the old files remain preserved and the error says so.
  - `list`: bounded listing, sidecar-based for normal GUI refresh.
- GUI Advanced invokes the owner API to create a snapshot and list backups. Restore requires plugin stop and CLI use, documented in `docs/BACKUP.md`.
- Upgrade/rollback instructions use Plugin Manager uninstall/install of versioned tarballs, database pre-backup, and the atomic restore flow.
- Existing schema migrations remain intact; restore refuses wrong schema/integrity instead of silently replacing data. No self-restore or alias can target the same file.

### Documentation and privacy sanitization

Updated/added:

- `docs/USER_GUIDE.md` — ordinary Desktop install/open, first run, seven pages, validation, backup, disable/re-enable, limits.
- `docs/BACKUP.md` — snapshot/verify/list/dry-run/restore/rollback with preserved files.
- `docs/UPGRADE.md` — ordinary install/upgrade/rollback and backup links.
- `docs/INSTALL.md`, `README.md`, `docs/RELEASE_NOTES.md` — current flows, counts, links, release/package checklist.
- `HANDOFF.md`, `docs/verification/V1_TEN_SCENARIOS.md` — final counts and evidence.
- `docs/verification/REPORT.md` and `docs/verification/creator-and-runtime.json` — removed exact Creator session/workspace UUIDs and private physical paths; technical claims/evidence remain, with exact identity moved to the ignored `.productization-task/PRIVATE_HANDOFF.md`.
- `package.json` — package whitelist narrowed to runtime source/client/scripts, locale, icon, patch, README, and user-facing docs only. HANDOFF, tests, ADRs, tasks/contracts, verification evidence, and Creator runtime records are excluded.
- `scripts/verify-package.mjs` + `test/package-privacy.test.js` — privacy/content gate that fails on private session/workspace UUIDs, absolute user paths, credential patterns, and raw database/log artifacts; package command runs it before packing.
- `README.md` no longer links package users to repository-only HANDOFF/ADR/verification files.
- This report. The report itself is excluded from the package.

## Changed files

Modified:

```text
HANDOFF.md
README.md
docs/INSTALL.md
docs/RELEASE_NOTES.md
docs/UPGRADE.md
docs/USER_GUIDE.md
docs/verification/REPORT.md
docs/verification/V1_TEN_SCENARIOS.md
docs/verification/creator-and-runtime.json
lib/client.js
package.json
src/client/factory.template.js
src/http.js
src/index.js
src/life-v1.js
src/store.js
test/productization.test.js
```

Added:

```text
.npmignore
docs/BACKUP.md
scripts/life-backup.mjs
scripts/verify-package.mjs
src/backup.js
test/backup.test.js
test/package-privacy.test.js
```

Private (ignored, not in package): `.productization-task/PRIVATE_HANDOFF.md` with exact session/workspace identity and recovery details. The existing private handoff is not deleted.

No `AGENTS.md` exists in this workspace; no instruction file was skipped.

## Exact local results

```text
npm run build
exit 0 — lib/client.js 78,196 bytes, 23 fields

npm test
exit 0 — 178 tests pass, 0 fail
quality-gaps 18, life-core 20, revision 9, wake-ledger 19,
wake-host 28, wake-consumption 26, life-v1 15, v1-budget 9,
final-hardening 8, setup-script 4, bootstrap 5,
productization 8, backup 7, privacy 2

node test/backup.test.js
7/7 pass

node test/productization.test.js
8/8 pass

npm run verify:package
ok true; 32 expected package files; no private UUID/path/credential/log findings

git diff --check
exit 0 (CRLF warnings only)
```

Backup CLI actually run against an isolated temp DB:

```text
backup → exit 0; snapshot + sidecar, schemaVersion 9, counts, SHA-256
mutate target → second intent added
restore --dry-run → exit 0; dryRun true, restored false, target untouched
restore → exit 0; restored true, previousPath preserved
verify/readback → exit 0; only the pre-mutation intent remains
```

Regression coverage added:

- **PROD3**: owner auth, same-origin, write marker, bounded `limit=201` rejection, malformed JSON → 400, intent create/activity start/attention yield/backup endpoints.
- **PROD6**: default Config and legal 75-second edit validate; string/array/number/boolean failures; idle cross-field error; set/unset ops and revision conflict.
- **PROD7**: admin intent/activity/attention derive Session scope and fail closed after binding revoke; invalid Session rejected.
- **PROD8**: real client render of First run in Chinese/English shows `本地活动` / `Local activity` as the third preset and `活动并发` / `Activity concurrency` only for budget.
- **BACKUP1–3**: consistent snapshot, dry-run no target, restore into isolated DB, restore over existing DB preserves `pre-restore`, malformed backup rejected without touching target, bounded naming.
- **BACKUP4**: read-only validation does not create `-wal`/`-shm`/`-journal`, change mtime, or change source bytes.
- **BACKUP5**: self-restore through a relative path alias, hardlink, and symlink is rejected before any change.
- **BACKUP6**: injected post-replacement verification failure quarantines the new target plus its sidecars and restores the old DB byte-for-byte.
- **BACKUP7**: injected pre-install verification failure leaves target and sidecars untouched.

## Package

```text
name: @amadeus/life
version: 1.0.0
command: npm run package
tarball: dist/amadeus-life-1.0.0.tgz
SHA-256: c457799bc10a2d4e187e1e5c56e70e04ceeda53ab82fb2282a8b46e08ccacfe9
size: 130,167 bytes
files: 32
```

Package contains the Host, built client, schema/config, locale, icon, README, user-facing docs, backup/build scripts, and patch. It excludes HANDOFF, tests, ADRs, tasks/contracts, verification/Creator-runtime evidence, databases, logs, node_modules, `.productization-task`, `.npm-cache`, and dist content. It contains 32 files and the hash above.

## Remaining gates (honest)

- **Real isolated DSH browser acceptance is still required**: install this tarball, confirm Settings entry/plugin card, seven tabs, normal save/cancel/default/conflict, intent create, activity start/pause/resume/cancel, yield, backup button, light/dark and narrow layout, keyboard focus, and no horizontal overflow.
- **Real Desktop backup/restore/upgrade/rollback acceptance**: run a backup, dry-run restore, actual restore on a stopped isolated plugin, disable/re-enable persistence, uninstall/reinstall tarballs, and verify the preserved `pre-restore` database.
- **License/public release**: the package is private/`UNLICENSED`; no license choice, public publish, or production deployment is made.
- **External platform/payment/real Provider**: not implemented; cost remains a reservation ledger.
- Creator `node --test test/*.test.js` still hits the Windows runner `spawn EPERM`; `npm test` runs every file directly.

## Codex isolated-DSH verification steps

1. Uninstall the old Life bundle/row; install `dist/amadeus-life-1.0.0.tgz` via Plugin Manager in the isolated Profile; enable it.
2. Confirm Settings has **Amadeus Life / Amadeus 生活**, plugin detail has the basic card, and no duplicate regressions.
3. Visit all seven tabs; test narrow window, light/dark, keyboard Tab/focus, disabled/loading/error states, no page-level horizontal scrollbar.
4. Create an intent for an authorized Session; change review time; cancel it with CAS; create an unbound-Session intent and confirm a clear error.
5. Start a local activity; pause/resume/cancel; use **Yield to user**; confirm it cannot mark completed.
6. Change wake interval 60→75, save, observe restart notice, restart, verify Host behavior; test invalid values show field errors.
7. Click **Back up now**; verify list metadata/SHA; run CLI `verify` and `restore --dry-run` against an isolated stopped database; then actually restore and validate intents/bindings.
8. Disable/re-enable the plugin; verify data persists. Uninstall/reinstall the old/new tarballs and restore the pre-upgrade snapshot; verify `life.sqlite.pre-restore-*` is preserved.
9. Verify owner API rejects non-owner, cross-origin, missing marker, malformed body, and over-limit requests; confirm no credentials/SQLite are exposed to the browser.
10. Record package hash, DSH version, and any remaining UI/layout issue; do not use production data.
