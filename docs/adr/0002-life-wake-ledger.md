# ADR 0002: Life wake ledger (v0.2.0 segment 1)

- Status: accepted for the first 0.2.0 vertical slice.
- Date: 2026-10-25 (Asia/Shanghai).
- Scope: additive SQLite v2 → v3 migration plus a durable intent-due wake ledger. No DSH calls, no model wake, no idle wake, no Persona/Provider work, no model tools.
- Contract baseline: `docs/contracts/qq-life-v0.1.md` and `docs/M0.md` remain unchanged. ADR 0001 describes the 0.1 runtime and its historical `schema_version = 2`; this ADR owns the current `schema_version = 3`.

## Context

0.1.0 ships local-only reconsideration events. The next segment needs a durable request that a trusted Host adapter can later claim and deliver to an existing DSH Session, without treating RPC acceptance as execution and without ever letting model-supplied text choose a target scope.

The Host API research found two possible delivery shapes (`ctx.sessionController.prompt(..., 'queue')`, or the Schedule-style `resolveAgent` + `agent.followup` + `sessions.flush`). This segment deliberately does not call either; it only persists safe, eligible wake requests. The Host adapter and real-session evidence checks belong to the following segment.

## Decisions

### 1. Additive v2 → v3 migration

- `LIFE_SCHEMA_VERSION` becomes `3`. A new database is created directly at v3 with `wake_requests` and its indexes.
- An existing store is first checked with `PRAGMA integrity_check`, `meta` presence, `schema_version` presence, and the complete v2 required-table set. Only a healthy v2 store is migrated.
- Migration runs inside `BEGIN IMMEDIATE`, re-reads `schema_version` inside the transaction, adds only `wake_requests` + indexes, and updates `meta.schema_version` last. Concurrent openers that waited on the write lock see version 3 and do not migrate again. A worker-thread regression opens the same healthy v2 store from two independent connections and confirms both see v3 with the original rows intact.
- On any failure the transaction rolls back; the original v2 file and rows remain. Unknown versions, missing metadata, missing tables, and corruption still fail with `LifeStorageError`; nothing is ever rebuilt or replaced with an empty store.
- The runtime lease, intents, activities, and intent_events are not altered by migration.

### 2. `wake_requests` contract

Columns: `id` (stable, `wake:<eventId>`), `kind` (`intent_due` only in this segment), unique `event_id`, `intent_id`, `intent_revision`, `context_scope`, `target_session_id`, `authorization_ref`, `status`, `claim_owner`, `attempts`, `next_attempt_at`, nullable `expires_at` / `message_id` / `admitted_at` / `executed_at` / `executed_turn_seq` / `last_error`, and `created_at` / `updated_at`.

Statuses: `pending | claimed | admitted | executed | uncertain | superseded | failed`. Indexes cover `(status, next_attempt_at)`, `(context_scope, status)`, and `(intent_id, intent_revision)`. The table stores no intent description, no prompt text, and no raw Session content.

### 3. Eligibility for intent-due wakes

`prepareDueWakes({limit})` scans only pending reconsideration events whose intent is still active, at the same revision, due by `reviewAt`, with an exact DSH Session scope shape (`session:session-<uuid>`) and `authorizationRef === 'life-tool:' + contextScope`. `targetSessionId` is derived from that trusted scope; model input never supplies a target. Events from other scopes or authorization refs remain local-only. The scan is bounded, and the SQL prefilter uses an exact hex-character GLOB before the `LIMIT`, so malformed session-shaped scopes cannot starve later valid events; JS re-validates the same strict shape. It is idempotent per `event_id`; repeated preparation keeps one row.

### 4. Claim and evidence state machine

- `claimNextWake({ownerId})` claims at most one `pending` wake whose `next_attempt_at <= now`, atomically setting `claimed`, owner, and incrementing `attempts`. Before delivery it re-validates event existence/kind/identity, scope shape, target derivation, authorization ref, expiry, and the intent's active status/revision/scope/review time. Invalid wakes become `superseded` and are not delivered. The reconsideration event must still be strictly `pending`: a local acknowledgement that wins the race supersedes a prepared wake at claim time, and admission repeats the same pending check. Two independent connections can claim at most once.
- `markWakeAdmitted(id, {ownerId, messageId})` only matches the claiming owner. Admission is not execution.
- `markWakeExecuted(id, {messageId, turnSeq})` only applies to an `admitted` wake with the same message id. It re-checks the intent; a changed/cancelled intent persists `superseded` and then returns `LIFE_STALE_RESULT`, never `executed` (the supersession is committed before the error is thrown). The real Session-event verification is deferred to the Host adapter segment; this method is the trusted recording point for that evidence.
- `markWakeUncertain(id, {ownerId, reason})` only matches the claiming owner and never schedules automatic redelivery.
- Intent update/cancel supersedes its `pending`, `claimed`, and `uncertain` wakes and clears their chance of a new execution. `admitted` wakes remain visible for reconciliation but cannot be marked executed after the intent changed.
- On adapter startup, wakes left `claimed` by a previous owner become `uncertain` (alongside the existing activity `unknown` recovery). This is not a redelivery.

### 5. Observable reads and health

`getWake`/`listWakes` are trusted reads for validation and future adapter tests, exposed only through the Host service; no model tool is added. `getHealth()` includes global wake counts; model-facing `getScopedHealth(scope)` includes only that scope's wake counts and still omits database paths and other scopes.

## Consequences and limits

- This segment cannot wake a model, cold-resume a Session, call `sessionController`, or prove execution. `executed` requires future trusted Host evidence (message id + turn sequence) supplied by the adapter.
- `claimed`/`admitted` are explicitly not execution; a crash between admission and evidence leaves an `admitted` wake that must be reconciled.
- No idle wakes, no Persona/Provider/opportunity logic, no budget enforcement beyond the single-row state machine, no cross-process queue beyond SQLite locking.
- Adapter disposal/lease semantics from 0.1 remain unchanged; the wake ledger adds no timer and no new tools.
- Verification in this segment is deterministic Node tests with synthetic temporary SQLite only. Real DSH delivery and restart behavior are deferred to the following segment and Codex's independent checks.
