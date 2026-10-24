# ADR 0003: Life Host wake adapter (0.2.0 segment 2, first slice)

- Status: accepted for the first trusted Host delivery slice.
- Date: 2026-10-25 (Asia/Shanghai).
- Scope: `src/wake-host.js`, adapter configuration/service wiring, safe target claim and pre-delivery recheck. No new model tools, no v3 table changes, no real DSH execution in this segment.
- Baseline: PR #2 / checkpoint `b21ecb2` (ledger + v3 migration). This ADR builds on ADR 0002 and does not alter the 0.1 evidence/association boundaries.

## Context

ADR 0002 made wake requests durable but local-only. The official Host pattern is now verified: `ctx.sessionController.resolveAgent(sessionId)` returns `{agent}` or `{error}`; a complete user-role message with `source.kind='amadeus-life'` and `source.wakeId` can be queued with `agent.followup(message)`; `await ctx.sessions.flush(agent.session)` is the durable admission acknowledgement; `ctx.on('session/event', handler, {global:true})` observes same-Session `user/message`, `turn/start`, and `turn/end`. `flush` success is not execution, and `turn/start` may precede the wake's own `user/message` in a turn that mixes other messages.

## Decisions

### 1. Delivery is administrator-only and default-off

`wakeDelivery` config: `{enabled:false, allowedSessionIds:[], intervalMs, maxPerDrive}`. Default is disabled with no allowlist, so a fresh install never wakes the Creator or any existing Session. Both an explicit `enabled:true` and a non-empty administrator allowlist are required; an allowlist alone stays off. Only a trusted Host config can change these values; model tools and runtime callers cannot. Allowed ids must be exact DSH Session ids. Invalid configuration fails plugin activation explicitly.

If `enabled` is true but `sessionController.resolveAgent` or `sessions.flush` (or `ctx.on`) is missing, the adapter reports `delivery.state = 'degraded'`, `reason = 'missing_capability'`, starts no listener/timer, and `driveDueWakesOnce()` returns `unavailable`. A listener-registration throw is treated the same way; delivery setup can never fail the whole Life plugin. Core Life tools remain usable. A disabled configuration reports `state = 'disabled'` and performs no tick, prepare, claim, resolve, or follow-up.

### 2. Bounded, single-instance drive

`driveDueWakesOnce()` is exposed on the trusted `life` service for controlled verification. It is serialized by an in-flight flag (`busy` on overlap) and each drive:

1. runs the bounded core `tick()` and `prepareDueWakes({limit})`;
2. asks the core `hasUnreconciledWakeForSession()` (a scope-indexed SQL `EXISTS` check, no row limit) and defers a Session that still has a `claimed`, `admitted`, or `uncertain` wake instead of piling up;
3. claims at most `maxPerDrive` (1–5) wakes, one allowlisted Session at a time, using `claimNextWake({ownerId, targetSessionId})` so a non-allowlisted wake is never claimed and then discarded;
4. performs no `resolveAgent`/`followup` when no eligible wake exists, so an empty ledger causes zero model calls.

The timer runs only when delivery is explicitly enabled with a non-empty allowlist and every capability exists. `intervalMs` is a low-frequency bounded value (1s–10min; default 60s), the timer is `unref()`ed, and only one drive can be in flight.

### 3. Claim, recheck, flush, admission

- `claimNextWake` keeps all v3 validation. The optional trusted `targetSessionId` filter is applied in SQL and validated as a DSH Session id.
- After the asynchronous `resolveAgent`, `recheckClaimedWake(id, {ownerId})` re-runs the same event/intent/revision/scope/authorization/expiry checks. If anything changed (cancel, retime, local acknowledge, scope/auth mismatch), the wake is persisted as `superseded` and no message is queued.
- The queued message is `{role:'user', id:<uuid>, content:[text], source:{kind:'amadeus-life', wakeId:<ledger id>}}`. The prompt contains only the wake id, intent id, expected revision, and an instruction to re-read current Life state; it contains no intent description or scripted outgoing text.
- `agent.followup` is used only. The adapter never calls `steer` or `cancel`, so a running turn is not overwritten.
- `sessions.flush` must return exactly `true`. `false`, a throw, or an unprovable state becomes `uncertain`; it is never retried automatically.
- Only after a durable flush does the adapter call `markWakeAdmitted` with the message id. `admitted` remains distinct from execution.

### 4. Execution evidence

A wake becomes `executed` only when the observer sees the exact same Session's `user/message` with `source.kind='amadeus-life'`, matching `source.wakeId` and matching message id, consumed by an open `turn/start`, followed by that same turn's `turn/end` with `reason.kind='completed'`. Then `markWakeExecuted(id, {messageId, turnSeq})` records the turn sequence. The evidence chain is strict at every layer: the live observer only tracks allowlisted Sessions, the observed-message cache requires the ledger's target Session id and wake id (not just a matching message id), `complete()` re-checks `targetSessionId`, and the snapshot scanner refuses a Session object that is not the target. Random message ids are not the security boundary.

Ignored as execution evidence: unrelated user messages, other-source or forged wake ids, messages from another Session, flush alone, failed/cancelled turns, and completed turns that did not consume the message. `turn/start` may precede the wake message; the observer tracks the open turn. When execution may have completed before ledger admission, the adapter checks its bounded observed-message cache and the Session's durable `snapshotEvents()` after admission; only the same matching/completed-turn rule can execute. Durable snapshot scans are limited to the last `SNAPSHOT_SCAN_LIMIT` (2000) events; if the matching evidence falls outside that window, the wake stays `admitted` rather than guessing.

### 5. Lifecycle

The adapter's existing runtime lease, ownership recovery, public `close()`, and disable semantics are kept. `WakeHost.stop()` clears its timer, removes the global `session/event` listener, marks itself disposed, and clears caches before the lease is released and SQLite closed. Every post-await path checks `disposed` before touching the core; disposed in-flight work may leave a wake `claimed`, which the next startup conservatively turns `uncertain`.

## Consequences and limits

- No real DSH Session was woken in this segment. Codex must independently verify the real Session Controller/followup/flush/event behavior, including busy Sessions, cold resume, archived Sessions, and the real turn/message ordering.
- Restart-time reconciliation of `admitted`/`uncertain` wakes against Session logs is intentionally deferred. This slice never resends them; they remain unreconciled and block further wakes for that Session until a later segment adds evidence-based reconciliation.
- The bounded prepare batch is shared with non-allowlisted due events. A large unrelated backlog can delay allowlisted wake preparation across drives, but it can never cause a non-allowlisted delivery or a model call without an eligible wake.
- A local acknowledgement racing a durable flush can leave a durably queued message with a `superseded` wake; it will not be marked executed. This conservative gap is deliberate and must be reconciled in a later segment.
- `resolveAgent` failures and unavailable Sessions become `uncertain` (no automatic retry). There is no budget ledger beyond `maxPerDrive`/allowlist, no idle wakes, no Persona/Provider work, and no platform sending.
- No new model tool is added; the trusted `driveDueWakesOnce` service method exists only for Host/operator verification.
