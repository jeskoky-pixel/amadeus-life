# ADR 0004: Life v4 wake-consumption evidence

- Status: accepted for the v4 persistence segment.
- Date: 2026-10-25 (Asia/Shanghai).
- Scope: SQLite v3 → v4 migration and trusted consumption/turn-end evidence APIs. No Host adapter delivery changes, no real DSH call, no model tool changes.
- Baseline: PR #2 checkpoint after the gated Host wake adapter. Builds on ADR 0002 (v3 ledger) and ADR 0003 (gated Host delivery).

## Context

The first real isolated DSH wake was consumed by a Session turn and completed, but the synthetic model then cancelled its own intent in the same turn. The v3 `markWakeExecuted` guard correctly refused to mark a wake executed when the intent revision had changed, superseding the wake — but that erased the independent fact that the DSH turn had consumed the wake and completed. v4 separates two facts:

1. **What happened in DSH**: a specific target Session, admitted message, turn, and completed turn-end consumed the wake.
2. **Whether the old intent is still current**: captured as `validAtConsumption` plus the intent's own independent status/revision.

`executed` in v4 means only "this wake's DSH turn completed"; it does not imply the linked intent is still active.

## Decisions

### 1. Additive v3 → v4 migration

- `LIFE_SCHEMA_VERSION` becomes `4`.
- A new database is created directly at v4. v4 adds one table, `wake_consumption`, and one index; it does not alter `intents`, `activities`, `intent_events`, `wake_requests`, or `runtime_leases`.
- A healthy v3 store is verified (integrity, metadata, v3 tables) and migrated inside `BEGIN IMMEDIATE`: the transaction re-reads `schema_version`, creates only `wake_consumption` + index, updates `meta.schema_version` last, and commits. Concurrent openers that waited see v4 and do not migrate again.
- A healthy v2 store is migrated **atomically to v4** in one transaction (the existing v3 wake table plus the v4 consumption table), so a v4-step failure cannot leave a half-migrated v2 file.
- Any corruption, unknown version, missing table, or migration failure rolls back and fails with `LifeStorageError`; nothing is rebuilt or silently replaced. v2/v3 rows, revisions, outbox, wakes, and leases are preserved.

### 2. `wake_consumption` evidence table

Columns: `wake_id`, `target_session_id`, `message_id`, `turn_seq`, `user_message_seq`, `valid_at_consumption` (0/1), `consumed_at`, `turn_end_seq`, `turn_reason`, `completed_at`, `updated_at`; primary key `(wake_id, message_id)`, plus `(target_session_id, turn_seq)` index. The table stores no prompt text, intent description, Session content, or authorization material.

### 3. Trusted recording APIs

- `recordWakeConsumed(id, {targetSessionId, messageId, turnSeq, userMessageSeq})`
  - Validates a DSH-shaped target Session, the wake's admitted message id, positive turn/user-message sequence numbers, and wake status (`admitted`, `superseded`, or `uncertain`).
  - Inside one transaction it checks the event/intent/revision/context scope/authorization/expiry still hold and persists `valid_at_consumption`. Event acknowledgement is allowed; a superseded event, missing intent, changed revision/scope/authorization, or expiry records `0`.
  - If invalid while the wake was `admitted`, the wake becomes `superseded`; the consumption fact remains. Same evidence is idempotent; conflicting coordinates are rejected with `LIFE_REVISION_CONFLICT`.
  - The Host adapter is responsible for proving the message/turn/source coordinates; the core accepts only explicit trusted coordinates.
- `recordWakeTurnEnd(id, {targetSessionId, messageId, turnSeq, turnEndSeq, reason})`
  - Requires prior consumption evidence with the same Session/message/turn; `turnEndSeq` must exceed `userMessageSeq`.
  - Completed turn with `valid_at_consumption = 1` promotes an `admitted`/`uncertain` wake to `executed`, recording `executed_turn_seq`. This deliberately does **not** re-check the intent's current revision, so a cancellation or retime later in the same turn cannot erase the completed-turn fact.
  - Completed turn with invalid consumption marks the wake `superseded`, never executed.
  - Non-completed turn (`error`, `cancelled`, etc.) never executes; the wake becomes `uncertain` (or stays superseded), conservatively requiring reconciliation and no automatic resend.
  - Same evidence is idempotent; conflicting turn-end sequence/reason is rejected.
- `getWakeConsumption(id)` is a trusted read-only service method. It is not exposed as a model tool; the model-facing tool count remains 9 and scoped health does not include evidence rows.

### 4. Relationship to v3 execution

The v3 `markWakeExecuted` path remains unchanged: with no consumption evidence, a changed/cancelled intent still produces `superseded` and `LIFE_STALE_RESULT`. v4 adds an independent evidence path rather than weakening that guard.

## Consequences and limits

- The Host adapter must be updated in the next segment to call these methods from trusted `session/event` evidence (`user/message` coordinates and `turn/end`); this segment does not wire them.
- Restart reconciliation of old `admitted`/`uncertain` wakes using `wake_consumption` remains future work. `uncertain` still blocks further wakes for that Session.
- Migration is additive but not reversible by this build; downgrade is unsupported and must fail closed.
- Real DSH migration/backup validation is performed independently by Codex against the cold-backed-up development database.
- No budget, idle wake, Persona, Provider, platform send, or new model tool is added.
