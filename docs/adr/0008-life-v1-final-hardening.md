# ADR 0008: Life v1 final hardening and v9 token reservations

- Status: implemented in the current worktree; real DSH lifecycle acceptance remains with Codex.
- Date: 2026-10-25 (Asia/Shanghai).
- Supersedes only the affected boundaries of ADR 0006/0007; schema v9 is additive.

## Session/Scene isolation

- `revokeSessionBinding` updates only activities with `owner_scope = session:<target>` and wakes for that target. It no longer affects another Session of the same Persona. Pending/running/paused/stopping become `unknown` and retain their resource lease until trusted terminal confirmation.
- A binding is immutable in Persona and Scene. Repeating the same Persona/Scene may refresh principal/auth and revision (including after revocation); changing either requires a new DSH Session. Old scope-keyed rows therefore cannot be reinterpreted under a new identity. Historical rows are preserved.
- Provider start and async operations capture the binding revision and recheck after every await. Revocation/late results cannot write running/completed/cancelled/paused; late status is conservative unknown.

## Provider authority

- `activities.provider_managed` (v9) distinguishes Provider-started activities from record-only activities. `LifeV1.startActivity` sets it; legacy `recordActivity` leaves it false.
- The central `transitionActivity` boundary rejects non-trusted changes to a provider-managed activity except conservative `unknown`/`stopping`. Terminal/unpause/resume/cancel-confirm requires trusted Provider evidence. Provider-managed `failed` additionally requires non-empty evidence at the central boundary, including reconciliation/finish routes; no evidence leaves the activity running/unknown and the resource lease held. The legacy model tool passes `trustedEvidence: false`, so it cannot fail/complete/release a Provider activity. Record-only behavior is unchanged.
- Provider finish/pause/resume/cancel/reconcile pass the trusted boundary; terminal states release the partial unique resource lease.

## Shared view

- Cross-scene summaries use a narrow allowlist: record id/status/revision/updatedAt (and activity priority for activities). `checkpointRef`, `resourceLease`, descriptions, authorization, principal, and internal paths are not returned cross-scene. Cross-scene Scene metadata also omits `dataScope` and `personaId`; the owner Scene may retain them.
- Only rows with the exact shared `scene_id` are included; legacy `scene_id IS NULL` records are not attributed to a Scene. A shared Scene still requires an explicit `scene_shares` grant; private Scenes never share.
- `revokeSceneShare` removes a grant; every read queries live state, so revocation/regrant/restart take effect immediately. The model cannot supply scene or dataScope.

## Token budget (v9)

- v9 adds `budget_scopes.tokens_reserved`, `token_reservations`, and `token_reservation_scopes`.
- `consumeWakeBudget` resolves all effective configured scopes (Session, active Persona, global), checks wake/token/cost limits together, increments wake calls, and reserves estimated tokens per scope. A non-null `wakeId` is unique (partial unique index); repeating the same wake/scope/amount returns the existing reservation with no counter changes, while a conflicting scope/amount fails closed. `wakeId:null` remains a distinct trusted reservation per call. Reservation rows are durable and survive restart/config changes/window rollover.
- `recordSessionUsage` is idempotent by official `(session, seq)`, selects the wake reservation (or latest Session reservation), and settles it once: 100 reserved + 70 actual => 70 used, 0 reserved; 100 + 150 => 150 used (can exceed limit and block new autonomous work). Missing usage leaves the reservation held; duplicate official events do not double-charge.
- Normal user turns are never blocked by autonomous budgets. Cost reservations remain separate trusted entries; no payment is performed.

## Schema and migration

- `LIFE_SCHEMA_VERSION = '9'`.
- v2–v8 chain through the existing transactions to v8, then a distinct v8 → v9 transaction adds `provider_managed`, `tokens_reserved`, token reservation tables, and the unique `wake_id` reservation index. Failure rolls back to v8. All old rows and counters are preserved; no reset/rebuild of business tables.
- Tests cover v6→v9, v7→v9, v8→v9, and rollback, plus worker races for activity and shared token limits.

## Setup

DSH Host plugins can expose a native `Config` schema, but this package stays dependency-free and keeps admin identity/binding operations out of model-facing setup. `scripts/life-setup.mjs` provides an offline guided preset generator/validator (core/autonomous/activity) that only prints/writes row config JSON; it never edits a profile or reads secrets, and `--out` uses exclusive create (`wx`) so an existing file is never overwritten. `docs/SETUP.md` is the one-screen path; detailed knobs remain in README.

Autonomous/activity presets emit explicit `bootstrap: {enabled:true, personaName}`. On activation, one stable Persona (`life_bootstrap_persona`), one deterministic private Scene per allowlisted Session, and one binding per Session are created in a single transaction. The same config is idempotent: existing correctly-bound Sessions cause no revision increment and no new rows; an existing different Persona/Scene fails closed with `setup.state:'failed'` / `reason:'bootstrap_failed'` and no mutation. Scenes are never shared automatically. Core-only emits no bootstrap. Target Sessions are the validated allowlist; model text cannot modify config or bindings. A custom identity remains possible by leaving bootstrap off and using the trusted admin `ctx.life` methods.

## Limits

The isolated developer DB migrated v8→v9 with integrity and old-column preservation checks. A real isolated DSH Session completed an autonomous due turn and local Provider activity, recorded official usage, and rejected a legacy model tool attempt with `LIFE_UNAUTHORIZED`; zero Persona/global wake budget deferred later delivery. The generated first-run preset loaded on a separate isolated DB and restarted idempotently. External Provider/payment and platform delivery remain unverified. Codex independently ran the standard `node --test test/*.test.js` runner (161/161) and all 11 `npm test` groups. The Creator sandbox had an earlier `spawn EPERM` limitation.
