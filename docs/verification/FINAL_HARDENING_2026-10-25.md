# Life v1 final hardening review — 2026-10-25

Scope: existing Life PR #2, development build `0.1.0`, SQLite schema v9. The five user-reported defects were reproduced in `test/final-hardening.test.js` before implementation: **0/5 passed** on the v8 baseline. The failing regression commit is `f7acf26`; the original 137 tests were retained. The original official cordis Creator Session did the principal implementation; Codex reviewed the diff and added three targeted failures for cross-scene scope exposure, evidence-free Provider failure, and duplicate wake budget reservation before the same Session repaired them. Codex also closed a revoked-bootstrap reactivation path.

| Finding | Resolution | Evidence |
|---|---|---|
| Session revocation affected every activity of the Persona | Restrict updates to the revoked Session owner scope; only its wakes and active activities are invalidated. Other Session revisions and leases stay unchanged. | FINAL1/FINAL1b and isolated DSH binding rejection |
| Legacy model tool could mark Provider work failed | Durable `provider_managed` marker; central transition boundary rejects untrusted terminal/pause/resume changes and requires Provider evidence for terminal failure/completion/cancellation. | FINAL2/FINAL6; real model called `life_activity_transition` and received `LIFE_UNAUTHORIZED` while activity status/revision remained unchanged |
| Rebinding a Session mixed old identity data | Persona and Scene for an existing Session are immutable. A different identity needs a new Session; old rows remain intact. | FINAL3 plus real isolated DSH attempt to bind a different Scene: `LIFE_UNAUTHORIZED`, binding preserved |
| Cross-scene shared read exposed internals | Exact Scene ownership and explicit grant required; no unassigned legacy rows; cross-scene allowlist omits description, checkpoint, resource, and owner scope. Grant revocation is checked on every read. | FINAL4 and shared-view tests, including revocation/regrant/restart |
| Estimated and actual token usage double counted; limits were Session-only | Durable per-wake reservation and single settlement from official usage; effective Session/Persona/global limit checks occur atomically. Missing usage keeps reservation; duplicate usage and wake IDs are idempotent. | FINAL5/FINAL7, budget worker/race and window tests; isolated DSH zero Persona/global limit deferred autonomous wake |

## Tests and migration

Codex independently ran `node --test test/*.test.js`: **161 passed, 0 failed**. `npm test` passed all 11 groups (18, 20, 9, 19, 28, 26, 15, 9, 8, 4, 5). The additional 24 tests extend the original 137 baseline; none of the old test files was removed.

The isolated developer Desktop was stopped by verified process identity; its SQLite, WAL, and SHM were cold copied and hash checked. On restart the real development database migrated **v8→v9**. `PRAGMA integrity_check` was `ok` before and after, and the old-column ordered digests and counts of 13 historical tables matched. The original Creator Session remained readable and idle. On v9, Plugin Manager applied disable, enable, remove, and reinstall, leaving Life installed and enabled. The independent profile patch was restored byte for byte after test probes.

On v9 a real isolated Session consumed a due wake without a human message, selected local virtual Provider start/status/finish tools, completed an activity with `local:start` and `local:complete` evidence, and recorded official token usage. A separate real model turn used the old transition tool on a Provider activity and received `LIFE_UNAUTHORIZED`. The synthetic zero Persona/global budget delivered no new wake and reported `budget deferred: wake_limit`. A different Scene rebind was rejected without changing the binding.

## First-run setup

The offline setup helper offers **Core only**, **Autonomous**, and **Local activity**. The latter two explicitly include a safe local bootstrap. A real isolated Desktop loaded the generated activity preset into a separate test database: schema v9, integrity `ok`, one Persona, one private Scene, one active binding at revision 1. Restart with the same config kept those counts and revision unchanged. The original development database and profile were restored afterward. See [one-screen setup](../SETUP.md).

## Limits

This is a development build; no formal v1.0 release, license decision, production deployment, PR merge, actual payment, QQ/Browser/other platform Provider, or external message was performed. Real platform execution and provider billing reconciliation need their own integrations and acceptance. The setup helper generates configuration but does not install a package or edit an existing profile.
