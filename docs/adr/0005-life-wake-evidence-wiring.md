# ADR 0005: Life v5 wake evidence wiring and conservative reconciliation

- Status: accepted for the Host wake-evidence wiring segment.
- Date: 2026-10-25 (Asia/Shanghai).
- Baseline: `4f690c1` (H20 regression added before this implementation).
- Scope: v4 evidence wiring into `session/event`, incremental SQLite v5, restart reconciliation. No new model tools, no platform sending, no second model loop.
- ADR 0002/0003/0004 remain the historical v3/v4 contracts. This ADR owns schema version `5`.

## Context

The first real isolated DSH wake was consumed by a turn and completed, but the model then cancelled its own intent in that same turn. v4 could record consumption and turn-end evidence separately, yet the Host adapter still used the old `markWakeExecuted` path and therefore lost the completed-turn fact when the intent revision changed (H20). A second race exists between `followup`, durable `flush`, and ledger admission: events (including completion) can arrive before `markWakeAdmitted`, and a crash after a successful flush must not leave a wake with no persistent message identity.

## Decisions

### 1. Incremental v5 schema

`LIFE_SCHEMA_VERSION` becomes `5`.

- `wake_requests` gains `prepared_message_id` and `prepared_at`, persisted **before** `agent.followup`.
- `wake_consumption` gains `validity_known` (1 = live observation fixed the intent validity; 0 = validity unknown, used only by after-the-fact snapshot reconciliation). Existing v4 rows migrate with the default `1`.
- Migration paths:
  - v2 → v5 in one transaction (wake table, consumption table, both v5 column sets);
  - v3 → v5 in one transaction (consumption table + ALTER wake columns);
  - v4 → v5 in one transaction (ALTER wake prepared columns + ALTER consumption `validity_known`).
- Every path verifies integrity/metadata/prior tables first, re-reads `schema_version` inside `BEGIN IMMEDIATE`, updates meta last, and rolls back on any failure. Existing intents, activities, intent events, wakes, consumption rows, and runtime lease are preserved. Unknown/corrupt/partial schemas fail closed; nothing is rebuilt.

### 2. Event evidence rules

Only allowlisted Sessions and events with `data.source.kind === 'amadeus-life'` are considered.

- `turn/start` records the current turn for the Session.
- `user/message` must match the wake's admitted **or prepared** message id, the same target Session, and the same `source.wakeId`. Immediately on that live event, the adapter calls `recordWakeConsumed` with the event `seq` and the open turn. This fixes `validAtConsumption` **before** the model can cancel or retime the intent.
- `turn/end` calls `recordWakeTurnEnd` with the turn, durable `seq`, and `reason.kind`.
  - `completed` + known-valid consumption → `executed`, even if the intent was cancelled/retimed later in that same turn.
  - `completed` + known-invalid consumption → never executed; wake stays superseded with evidence.
  - non-completed turn → never executed; wake becomes conservative `uncertain` (or stays superseded).
- Duplicate events are idempotent at the core; conflicting turn/message/seq coordinates are rejected and never fabricate execution.
- The adapter never treats prompt text, model narration, `accepted`, or a mere flush as execution evidence.

### 3. Delivery race and crash window

- Immediately after resolving the Agent and rechecking the claim, the adapter generates the message id, persists it with `prepareWakeDelivery`, then calls `followup`.
- `flush` success alone is not admission. The adapter records admission afterwards; if events already completed the wake, the admission failure is harmless because the wake is already `executed`.
- A crash after preparing (or after a durable flush) leaves `claimed`/`uncertain` with a persistent `prepared_message_id`; startup turns claimed wakes uncertain. Restart reconciliation can then match this id against the official Session snapshot.
- `prepared`, `admitted`, `consumed`, and `turn completed` remain distinct facts. A prepared message with no snapshot/consumption evidence stays unreconciled and blocks further wakes for that Session; it is never automatically resent.

### 4. Restart reconciliation

Before the first claim of a new Host binding, `driveDueWakesOnce()` runs a bounded reconciliation using the real Host history API:

- For each allowlisted Session with unreconciled (`claimed`/`admitted`/`uncertain`) wakes, call `ctx.sessionController.projections({sessionId}, signal)` for the exact `asOfSeq`, then `ctx.sessionController.page({address:{kind:'session',sessionId}, throughSeq, maxMessages, turnWindow, beforeSeq?}, signal)` for chronological `{type:'event', event}` records. Both calls receive an AbortSignal owned by the reconciliation (aborted on dispose). Do **not** use `resolveAgent` for cold history and do **not** invent an `inspect` method.
- History is bounded: at most 4 pages of 200 messages and at most 800 events are retained. If `hasMore` is still true, the page budget is exhausted, the response shape is unexpected, or `projections` is null/migration-required, the history is marked incomplete for that attempt.
- Match exactly one `user/message` with the persistent message id, `source.kind='amadeus-life'`, and `source.wakeId` inside an open turn; then require the same turn's `turn/end` after it.
- Evidence is recorded through `recordWakeConsumedFromSnapshot` (`validity_known=0`, never guessed valid) and `recordWakeTurnEnd`. A completed turn can clear the wake and release the Session for a later wake; failure/cancel keeps it unreconciled.
- The scanner keeps its last `SNAPSHOT_SCAN_LIMIT` (2000) event bound as a second safety net. If the evidence is outside the retained window, if the history capability is unavailable, or if the match is not unique, the wake stays unreconciled. Timeout is never treated as completion.
- A transient history failure does not permanently mark reconciliation done. Attempts use bounded exponential backoff (30s doubling to 5 min) and later drives retry. Successful passes are throttled to the delivery interval. Health exposes `delivery.reconciliation` (`pending`/`running`/`partial`/`done`/`degraded`/`unavailable`) and `unresolvedWakes`.
- Health stays `active` only when no allowlisted Session has an unresolved wake. With unresolved wakes, `health().state` becomes `degraded` with `reconciliation_unavailable`, `reconciliation_pending`, or `reconciliation_unresolved`; it does not degrade merely because old-wake count is zero.

### 5. Lifecycle and scope

- Default delivery remains disabled; only explicit `enabled:true` plus a non-empty administrator allowlist activates listener/timer.
- Optional `ctx.inject` binding and generation-safe rebind/unbind stay in force; listener/timer are never duplicated, and disposed async work never touches closed SQLite.
- No new model tool is added; the trusted service exposes only recording/reconciliation methods.

## Consequences and limits

- Real DSH history requests were not exercised by this build; the implementation follows the installed session-controller contract (`projections({sessionId}, signal)`, `page({address,throughSeq,maxMessages,turnWindow,beforeSeq?}, signal)` returning `{records,hasMore}` with `{type:'event',event}` entries). Codex's real isolated smoke must confirm exact request acceptance/page ordering and report any delta.
- Reconciliation is conservative: a bounded window miss, non-unique message match, unavailable `projections`/`page`, or exhausted page budget leaves the wake unreconciled; retries are bounded by backoff and never auto-resend.
- `validity_known=0` records that completion was proven but the old intent validity at consumption was unknown; it is never promoted to valid.
- A crash exactly between `followup` and `flush` may leave a message in the Agent inbox whose durability is unconfirmed; the wake stays claimed/uncertain with the prepared id and is never automatically resent.
- No platform messages, idle wakes, Persona/Provider work, budget ledger, or extra model tools are added.

## Verification added

- v2/v3/v4 → v5 migrations, failure rollback, concurrent openers, preserved consumption rows.
- `recordWakeConsumed` live validity, prepared/claimed pre-admission consumption, same-turn cancel/retime completion, cancel-before-consumption, error turn, unknown-validity snapshot completion, coordinate conflicts and idempotency.
- Host: H20 live consumption + same-turn cancel, pre-admission completion before flush, flush-crash restart reconciliation, prepared-id crash window, bounded-window non-reconciliation, duplicate events, wrong message id, retry after transient history failure, missing-history-capability health, and page/projections reconciliation without `inspect`.
