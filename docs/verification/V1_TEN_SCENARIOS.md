# Life v1.0 ten-scenario deterministic mapping

Date: 2026-10-25. This maps the user-defined ten scenarios to deterministic local tests. It is **not** real DSH/platform acceptance; Codex must run the isolated real lifecycle.

| Scenario | Deterministic coverage | What is actually proven |
|---|---|---|
| 1. Idle wake without user input | `life-v1.test.js` E2, E5 | Host allocates/delivers one idle opportunity after quiet window without a user message; frequency/quiet bounds; idle prompt is rest/silent-only. |
| 2. Future intent due | `wake-host.test.js` H20/H22/H24/H25, `wake-ledger`/`wake-consumption` | Durable due event → claim → preparation/admission → turn evidence; no duplicate delivery. |
| 3. Virtual Provider closed loop | `life-v1.test.js` E3, E7 | Opt-in model tools start/status/pause/resume/cancel/finish a bound local Provider activity; Provider evidence, not model text, records state and completion/failure. |
| 4. New message during activity | `life-v1.test.js` E9, E9b | Real user `user/message` pauses/checkpoints a long activity when supported; otherwise conservative `unknown`; activity/lease preserved, not cancelled or resent. |
| 5. Two authorized scenes + private isolation | `life-v1.test.js` E1, E10 | Binding-derived shared read sees only own scene or explicit shared+grant; third unbound Session denied; private descriptions/auth refs absent; revocation immediately denies. |
| 6. Interruption recovery | `wake-host` H22/H25, `wake-consumption` A7–A13, `life-v1` E3/E9b | Bounded official history reconciliation, prepared message ID crash window, v5→v9/v6→v9/v7→v9/v8→v9 migration and rollback, Provider crash→unknown and lease retention, token reservations surviving restart. |
| 7. Budget boundary | `life-v1.test.js` E4, E6, E11; `v1-budget.test.js` BUD1–BUD9; `final-hardening` FINAL5/FINAL7 | Atomic wake/token/cost reservation, activity concurrency (Session/Persona/global, no-resource bypass impossible), exhaustion defers autonomous work with reason, normal chat unaffected, official usage idempotency and per-wake settlement, wakeId idempotence across restart/workers, two workers cannot exceed shared Persona/global wakes, paid reservation inventory/unknown/idempotency. |
| 8. Module degradation | `wake-host` H2/H13/H29, `quality-gaps`, `wake-consumption` A6/A8 | Missing Host capability/lease conflict/corrupt or partial schema fail closed; unresolved wakes keep health degraded. |
| 9. Cancellation and permission revocation | `life-v1.test.js` E1, E3, E8, E12–E14; `final-hardening` FINAL1/FINAL1b/FINAL2/FINAL3; `life-core`/`revision` | Session revocation touches only its own Session-owned wakes/activities, preserving another Session of the same Persona; pending/paused/late Provider paths stay unknown with lease; Provider-managed activities cannot be failed/completed/cancelled/paused by untrusted model paths; Session Persona/Scene is immutable in place. |
| 10. Plugin lifecycle | `wake-host` H8/H16/H18/H19, `life-core` adapter tests | Enable/disable/rebind, duplicate listener/timer suppression, in-flight generation checks, dispose closes SQLite and releases lease. |

## Deliberately unverified / limits

- An isolated real DSH Session completed an idle turn without user input and later selected activity start/status/finish tools for a local virtual Provider. No platform send.
- The actual isolated developer SQLite was cold backed up and migrated v7→v8, then v8→v9; integrity and old-column digests matched (13 historical tables in the v9 migration). Earlier-version migrations and rollback are covered by deterministic tests.
- Setup helper `scripts/life-setup.mjs`, `docs/SETUP.md`, bootstrap first-run/idempotence/conflict, and exclusive `--out` are covered by `setup-script.test.js` + `bootstrap.test.js`. The 1.0.0 native Settings client, flat Config schema/forms, owner-auth admin API, client registration, and package manifest are covered by `productization.test.js`; the real browser click-through and tarball install still require isolated DSH acceptance.
- The current v9/productization tree reports 178 deterministic tests via `npm test` (productization 8, backup 7, privacy 2). It covers volatile Config/form operations, idempotent registration/unload, admin intent/activity/attention access control, malformed HTTP input, SQLite consistent backup/atomic restore/preflight rollback. Codex independently ran `node --test test/*.test.js` (161/161) on the pre-productization v9 tree; the Creator sandbox still has the `spawn EPERM` limitation.
- Only `LocalVirtualProvider` exists. External Provider/gateway, payment, publication, and platform adapters are not implemented.
- Token usage accepts only official `assistant/message.data.usage`; when absent, health reports `usage_unknown` and the conservative reservation remains. Actual provider billing/cost settlement is not claimed.
- The paid-capability interface is a local reservation ledger only: no payment Provider, billing, refund, or external call is installed.
- Shared view is a minimal reference/status view, not a memory/Persona content system; cross-scene descriptions are intentionally omitted.
- Multi-process contention beyond SQLite atomic checks is not load-tested. Quiet hours are UTC; no user-timezone preference UI.
