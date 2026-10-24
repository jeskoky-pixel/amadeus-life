# ADR 0006: Life v1.0 identity, idle, budget, and activity provider

- Status: implemented for the current development tree; real isolated DSH lifecycle acceptance remains with Codex.
- Date: 2026-10-25 (Asia/Shanghai).
- Baseline: v5 Host wake evidence (`e971906`/113 tests) with the real `sessionController.projections/page` reconciliation from ADR 0005.
- Scope: additive SQLite v7, trusted Host service plus opt-in model tools for the local virtual Provider and shared read. No platform send, no second Agent/model loop.
- Schema note: ADR 0007 extends this tree to v8 (activity concurrency + paid-cost reservation); v2–v7 remain readable/migratable.

## 1. Schema v7 (incremental)

All existing v2–v6 data is preserved; v2/v3/v4 use the existing transactional paths to v5, then v5 → v6 and v6 → v7. A failed step rolls back to its source version.

New v6 columns:
- `wake_requests`: `origin` (`intent`/`idle`), `idle_key`, `persona_id`, `scene_id`; partial unique index on `idle_key`.
- `intents`: `persona_id`, `scene_id`, `priority`.
- `activities`: `persona_id`, `scene_id`, `priority`, `checkpoint_ref`, `resource_lease`, `deadline_at`.

New v6 tables:
- `personas(id, name, revision, ...)`
- `scenes(id, persona_id, context_scope, privacy private|shared, revision, ...)`
- `scene_shares(scene_id, data_scope, granted_at)`
- `session_bindings(target_session_id PK, persona_id, scene_id, principal_id, authorization_ref, active, revision, ...)`
- `idle_state(target_session_id PK, last_event_at, last_idle_at, updated_at)`
- `budget_scopes(scope PK, window_ms, wake_limit, token_limit, cost_limit, window_start, counters, revision, ...)`

New v7 additions:
- `usage_events(target_session_id, seq, input_tokens, output_tokens, total_tokens, recorded_at)` with `(target_session_id, seq)` primary key for idempotent official usage accounting.
- Partial unique index `idx_activity_resource_lease` on `activities(resource_lease)` for `pending/running/paused/stopping/unknown`; terminal states release the resource by leaving the partial index.

`LIFE_SCHEMA_VERSION` becomes `7`; `PRAGMA integrity_check`, required tables/columns, and version re-read inside `BEGIN IMMEDIATE` remain mandatory. No rebuild/reset/empty replacement.

## 2. Identity separation

- Persona, Scene, DSH Session, Principal, and Data Scope are separate values. Only trusted Host/admin methods (`createPersona`, `createScene`, `bindSession`, `grantSceneShare`, `revokeSessionBinding`) can bind them. No model argument can set or elevate scope/persona/principal.
- A private scene is visible only in its own context scope. A shared scene requires an explicit `scene_shares` grant for another scope.
- `bindSession` increments the binding revision; Session binding is the only route to idle opportunities. `revokeSessionBinding` deactivates the binding and atomically:
  - supersedes pending/claimed/admitted/uncertain wakes for that Session;
  - marks running/paused/stopping activities for the bound persona as `unknown` (never completed).
- Existing wake/activity owner scopes remain authoritative; late results keep their original `scope` + revision and cannot be redirected to a random idle Session.

## 3. Idle heartbeat

Idle opportunities reuse the v5 wake ledger, delivery listener, prepared message ID, admission, consumption evidence, and restart reconciliation. They are distinguished by `origin='idle'` and a persistent `idle_key`; the legacy `kind` column remains `intent_due` so no CHECK-table rebuild is required.

- `noteSessionActivity` persists the last trusted Session event time.
- `allocateIdleWake` is a single transaction:
  - requires an active binding (persona/scene/principal/auth/revision);
  - refuses if any pending/claimed/admitted/uncertain wake exists for the Session;
  - enforces a persisted quiet-activity window and one opportunity per time window;
  - inserts an idle wake with a unique `idle:<session>:<window>` key; a duplicate key is a no-op.
- The Host checks `wakeDelivery` enablement + allowlist, active turns, optional quiet hours (UTC), and then calls `allocateIdleWake`. It never calls the model merely because a tick occurred.
- Idle validity uses the binding revision/persona/scene/authorization, not an intent event. Admission/turn-end/consumption use the same v4 evidence semantics. An idle wake is only an opportunity to rest or stay silent; the prompt explicitly forbids external sends and no platform adapter exists.
- Budget, allowlist, uncertain-blocking, prepared-message crash recovery, and bounded history reconciliation are shared with intent wakes.

## 4. Unified autonomous budget

- `budget_scopes` persists per-scope window, limits, counters and revision. `consumeWakeBudget` is an atomic `BEGIN IMMEDIATE` reservation, safe across concurrent adapters.
- Limits may cover wake/model calls, estimated tokens, and cost units. No daily behavior quota is invented beyond administrator config; default disabled.
- The Host reserves one wake before delivery. If denied, it releases the claim back to `pending` with the budget reason, records `health().delivery.budget.lastError`, and makes no model/Host call. If budget is enabled but a scope is unconfigured, the Host also defers.
- Unconfigured budget scopes are allowed at the core level for compatibility, but when `wakeBudget.enabled` the Host treats `unconfigured` as deferral. Ordinary chat/intent creation is never budget-blocked.
- Exhaustion defers autonomous work only; there is no resend and no fabricated completion.
- Official `assistant/message.data.usage` (`inputTokens`, `outputTokens`, `totalTokens`) is recorded only for turns that consumed an `amadeus-life` wake. `usage_events` makes recording idempotent by Session + seq; actual tokens are added to the same persistent budget scope. Duplicate/replayed seq does not double-count. If the event has no trusted usage field, health reports `usage_unknown` and the conservative wake reservation remains in force; no real token-cost settlement is claimed.

## 5. Activity Provider contract

Trusted interface: `describe`, `start`, `status`, `cancel`; optional `pause`, `resume`, `checkpoint`, `reconcile`. `LocalVirtualProvider` is the controlled local implementation; no external Provider is installed.

- `startActivity` inserts a pending activity, then calls the Provider. Provider running evidence is written to the activity; a Provider throw/timeout becomes `unknown`, never `completed`.
- Pause/resume/checkpoint are Provider-confirmed transitions; checkpoint refs and resource leases are durable.
- Cancel moves a running/paused activity to `stopping`, asks the Provider, and only trusted Provider evidence can move it to `cancelled`. Unknown Provider state stays `unknown`.
- `reconcile` can move `unknown` to completed/failed/cancelled only with Provider evidence (`trustedEvidence`); model-written `evidenceRefs`, `note`, or timeout cannot complete an external activity.
- Duplicate/racing operations rely on revision CAS; stale operations fail without resurrecting an old intent.

- Provider `resource_lease` is a real SQLite mutex: the partial unique index rejects a second active activity on the same resource; terminal states release it. Process interruption leaves the activity `unknown` and keeps the lease until explicit Provider/tool reconciliation.
- Model-facing tools are opt-in and derived from the active binding:
  - `activityTools.enabled` registers `life_activity_start/status/pause/resume/cancel/finish`; the model supplies only purpose/priority/resource/deadline/desired outcome, never provider/persona/scene/scope/trusted evidence. Only `local-virtual` is selectable; completion/failure refs come from the Provider.
  - `sharedRead.enabled` registers `life_shared_read`, which returns only the caller binding's own scene plus explicitly shared+granted scenes; cross-scene descriptions are omitted, and authorization/principal references are never returned.
  - Default tools remain the original nine; new tools are absent unless explicitly enabled.
- Real user `user/message` events give the user turn priority over same-Session long activities: Provider-supported pause + checkpoint, otherwise conservative `unknown`. The activity and lease are not destroyed; a later turn may resume using the original scope/revision/authorization.
- New activity intent links repeat the `recordActivity` invariants inside the insert transaction (existence, same owner scope, not cancelled, focused-activity consistency). Missing/foreign/cancelled links leave no pending row and never start the Provider.
- Provider-start operations capture the binding revision and recheck after every await. Revocation covers pending as well as running/paused/stopping; a late Provider running/completed/status result after revocation is not applied and leaves the activity `unknown` with its resource lease for reconciliation, never retried automatically.

## 6. Recovery and degradation

- Same-process start/stop, process interruption, duplicate events, concurrent claims, unknown activities, missing Provider, revoked permissions, budget failure, corrupt DB, and lease conflict retain the v3–v5 behavior: fail closed, conservative unknown/uncertain, no timeout completion, no resend.
- Startup marks interrupted running/stopping activities unknown; wake reconciliation still requires exact Session/message/wake/turn evidence via `projections/page`; bounded pages/incomplete history leave wakes unresolved and health degraded.
- Delivery remains default-off. The existing optional Cordis injection, generation checks, listener/timer teardown, and the original nine model tools are unchanged by default; the five activity tools and shared-read tool are registered only when their explicit admin flags are enabled.

## 7. Verification and limits

Deterministic `test/life-v1.test.js` covers v7 schema, private/shared scene isolation, binding/revocation invalidation, idle quiet/frequency/delivery, virtual Provider lifecycle + crash/unknown, unified budget boundary (including normal intent creation), Host budget deferral, opt-in model tools, resource-lease exclusion/release, user-turn pause/checkpoint/unknown priority, two-authorized-scene shared read plus third-Session denial, official `assistant/message.usage` idempotent accounting, intent-link existence/scope/cancelled checks (E12), revocation during pending Provider start (E13), and late Provider completion/status after revocation (E14). Existing suites cover v2/v3/v4/v5 migrations, wake evidence, reconciliation, lifecycle, and degradation; migration tests cover v5 → v7, v6 → v7, and rollback.

Not proven here: real DSH idle lifecycle with no user input, real external Provider (none installed), platform behavior, exact real model token-cost settlement (only official event usage fields are accepted), multi-instance budget/resource contention under real concurrency, and quiet-hours timezone preferences beyond UTC. Real migration of the developer SQLite must be cold-backed-up and accepted by Codex; this build does not touch it. See `docs/verification/V1_TEN_SCENARIOS.md` for the deterministic mapping and still-unverified list.
