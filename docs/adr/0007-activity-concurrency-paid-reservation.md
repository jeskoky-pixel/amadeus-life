# ADR 0007: Unified activity concurrency and paid-cost reservations

- Status: historical v8 slice; ADR 0008 extends the tree to v9. Real platform payment remains unverified.
- Date: 2026-10-25 (Asia/Shanghai).
- Scope: active activity concurrency in `budget_scopes`, trusted paid-capability reservation interface, additive SQLite v7 → v8.
- Schema note: v9 (ADR 0008) preserves these counters/reservations and adds token reservation tables/provider-managed marker.

## Schema v8

- `budget_scopes.activity_limit INTEGER` (NULL = disabled).
- `budget_scopes.cost_reserved INTEGER NOT NULL DEFAULT 0 CHECK (cost_reserved >= 0)`, preserving existing `cost_used`/`cost_limit` counters.
- `cost_reservations(id PK, scope, amount, status reserved|settled|released, idempotency_key UNIQUE, timestamps, revision)`.
- v2–v7 stores migrate incrementally via the existing v5→v6→v7 path and a distinct v7→v8 transaction; failure rolls back to v7. Existing budgets, wakes, activities, usage rows, and reservations are preserved. No rebuild/reset/empty replacement.

## Activity concurrency

- A new activity checks every configured effective scope inside the same `BEGIN IMMEDIATE` transaction as the INSERT:
  - `session:<id>` by `owner_scope`;
  - `persona:<id>` by `activities.persona_id`;
  - `global` by all activities.
- Active/possibly-occupying statuses are `pending`, `running`, `paused`, `stopping`, `unknown`. `completed`, `failed`, and `cancelled` release the slot.
- The check is independent of `resource`; omitting a resource cannot bypass it. The resource-lease unique index remains an additional mutex.
- Both model tools and trusted service calls go through `LifeV1.startActivity`, so both paths share the check. A denied start leaves no activity row and never calls the Provider; the error reports `reason: activity_limit` and the effective scope.
- Default: no `activity_limit` rows = disabled. Admin can configure a Session limit through `wakeBudget.activityLimit` or trusted `configureBudget` for persona/global scopes.
- Existing activities may still be read/cancelled; ordinary chat/intent paths are not blocked.

## Paid-cost reservation interface

No payment Provider is installed or called. Trusted Host services only:

- `reserveCost({scope, amount, idempotencyKey?})`: atomic; requires a configured `cost_limit`; checks `cost_limit - cost_used - cost_reserved`; inserts a reservation and increments `cost_reserved`. Same idempotency key returns the same reservation; conflicting key/amount is rejected.
- `settleCost({reservationId, actualCost})`: only `reserved → settled`; `actualCost` must be a non-negative integer no greater than the reserved amount; decrements `cost_reserved`, increments `cost_used`, rejects duplicate/negative/over-reservation settlement.
- `releaseCost({reservationId})`: only `reserved → released` because the action was explicitly not executed; decrements `cost_reserved`.
- Unknown/unconfirmed outcomes simply remain `reserved` and continue occupying budget; there is no automatic release and no duplicate settlement. No negative counters are possible.
- `consumeWakeBudget` now also accounts for `cost_reserved`, so paid reservations and wake cost cannot double-spend the same limit.
- No model tool exposes any of these methods; no payment, publish, deploy, or external Provider invocation is implemented.

## Verification

`test/v1-budget.test.js` covers no-resource bypass, unknown retention, terminal release, session/persona/global scope independence, model-tool limit enforcement, paid reservation idempotency/exhaustion/settlement/release/unknown retention/scope isolation, and two independent workers racing one limit. `test/wake-consumption.test.js` covers v6→v8, v7→v8, and failed v7→v8 rollback. Full suite is reported in README/HANDOFF.

## Limits

- Real payment Provider settlement, billing reconciliation, refunds, and platform cost are not implemented or claimed.
- SQLite atomicity is proven in deterministic worker tests; external multi-host contention against the same file is not load-tested.
- Activity limits are counted from Life's durable activity state; an external Provider that continues work after Life marks an activity terminal cannot be detected without a real reconciliation Provider.
- Admin scope values are trusted inputs; model text cannot select a budget scope.
