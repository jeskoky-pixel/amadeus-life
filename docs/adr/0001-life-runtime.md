# ADR 0001: Life runtime — SQLite ledger, bounded tick, local reconsideration

- Status: accepted for the T-010 implementation (first runnable Life version).
- Date: 2026-10-25 (Asia/Shanghai).
- Scope: `amadeus-life` only. No QQ, Memory, State, browser, platform, or other plugin internals.
- Contract baseline: `docs/contracts/qq-life-v0.1.md` and `docs/M0.md` remain unchanged design copies. This ADR records implementation choices; it does not silently revise the shared contract.

## Context

T-010 requires a real, installable DSH plugin that owns future intents, activity state, and reconsideration timing, while preserving revision, cancellation, restart, and corruption semantics. The first version may expose reconsideration events locally only and must clearly document that limit.

## Bounded API findings (inspected, not assumed)

Inspected through the Host `Service`/`Config` Inspect providers and the installed package sources under the official app.asar:

- **Schedule** (`@deepseek-ai/dsh-schedule`): `create(sessionId, request)` / `list` / `catalog` / `history` / `delete` / `update`. The package description is "Host-wide durable reminders with shared management and original-Session delivery"; reads, deletion, and timing edits never activate a Session.
- **Jobs** (`ctx.jobs`, `@deepseek-ai/dsh-jobs-local`): abstract process-bound job registry (`start`, `list`, `get`, `read`, `readAt`, `kill`, `wait`, `remove`, `attachController`).
- **Tools** (`@deepseek-ai/dsh-tools`): `defineTool` converts a parameter DSL into JSON Schema, but the registry's `schemaOf` projects `definition.parameters` directly as the model-facing schema. `output.schema` must be raw JSON Schema and `output.render` is required at registration. Tool execution receives `exec.agent` and `exec.signal`.
- **Cordis 4** (`@deepseek-ai/cordis`): `ctx.provide(name, value)` registers a fiber-owned service and returns a disposer; `ctx.effect(fn)` registers a disposal-managed effect; plugin export form `apply(ctx, config)` with `inject` is a documented Host plugin form.

## Decisions

### 0. Single-runtime adapter lease

The database lives under one SQLite store, but startup recovery must not be performed by two live adapters. A `runtime_leases` row records `owner_id`, `pid`, and `acquired_at`. Acquisition succeeds for the first adapter or when the recorded PID is **provably dead** (`process.kill(pid, 0)` → `ESRCH`); an alive, `EPERM`, or ambiguous PID keeps the lease and the second adapter fails closed with `state: 'degraded'`, `reason: 'runtime_lease_held'`, and no tools/timer/recovery. Only the exact owner can release. This is not a job/agent framework; core-level independent connections for atomic due claiming remain possible because the lease is an adapter-level concern.

### 1. SQLite ledger via `node:sqlite` (no dependency)

The store uses the synchronous `node:sqlite` `DatabaseSync` API available on the installed Node 22. WAL, `busy_timeout = 5000`, and `BEGIN IMMEDIATE` for every mutation provide independent-connection safety; mutations additionally use revision CAS (`WHERE revision = ?`) and uniqueness constraints. JSON-file concurrency was rejected because it cannot provide these guarantees.

### 2. Why not implement timing through Schedule or Jobs

- Life's due review needs exactly one durable, reference-bearing reconsideration event **per intent revision**, atomic with the claim, and safe across restart/duplicate ticks. Schedule's reminder delivery reawakens the original Session (a DSH prompt turn) and does not carry a Life intent revision identity or a Life outbox dedupe key. Wiring Life into Schedule would also write user-visible reminder tasks and couple internal ledger state to reminder deletion/edit UX.
- Jobs-local is process-bound and is an agent job runner, not a durable timer/outbox; restart recovery is explicitly out of its scope.
- Therefore the minimal independent Life timer is an **injected clock plus one lifecycle-owned bounded tick**. An empty tick performs one bounded indexed query and produces nothing; it never calls a model. The adapter's interval is `unref()`ed and cleared on disposal.

### 3. Event, acknowledgement, and completion semantics

- One `reconsideration` event per `(intentId, revision)`, with a stable id `reconsider:<intentId>:<revision>` and a `UNIQUE(intent_id, intent_revision, type)` constraint.
- Retiming/editing creates a new revision and supersedes the old pending event; cancellation supersedes all pending events.
- `acknowledgeEvent` only records local consumption. It is not external completion; activities carry their own evidence and status.
- The event payload contains references only (intent id/revision, scope reference, related activity, review time) and `delivery: 'local-only'`. It deliberately contains no intent description, no authorization reference, and no message text. A host-wide bus therefore cannot leak intent content; an authorized `getIntent` reads the description separately.
- The model-facing health tool returns general tick health plus only the caller's scoped counts. The trusted Host `getHealth()` retains database path and global diagnostics for operators.
- No automatic DSH wake, no external writer, and no LLM call exists in this version.

### 4. Trusted scope and authorization

- Intent/activity scope is **derived from the live tool execution context** (`exec.agent.session.id`) in the adapter. Model-supplied strings never set scope, ownership, or authorization.
- Because raw `ctx.tools.register` does not enforce the JSON Schema (only `defineTool` adds argument validation), the adapter installs its own argument guard on every model-facing tool: unknown and reserved keys (`scope`, `ownerScope`, `contextScope`, `authorizationRef`, `trustedEvidence`) are rejected with `LIFE_VALIDATION`, and `life_intent_update` copies only explicitly allowlisted editable fields. Regression test invokes the registered `execute` with hostile extras and verifies the victim intent is unchanged.
- Service callers must pass an explicit trusted scope. Reads/updates/cancels are owner-scoped; mismatches fail with `LIFE_UNAUTHORIZED`.
- Related-object links are validated inside the same transaction as the write: missing activities/intents fail `LIFE_NOT_FOUND`, foreign-scope links fail `LIFE_UNAUTHORIZED`, conflicting reverse focus fails `LIFE_VALIDATION`, and a cancelled intent cannot receive a new activity. `relatedActivityId` is an optional single focus: an intent may own multiple activities, and adding another activity is allowed when the current focus exists, is in the same scope, and either has no owning intent yet (one-way focus created before its intent) or points back to the same intent; the focus and the intent revision are left unchanged. Legacy focus values that are missing, foreign-scope, or bound to another intent are refused conservatively without partial writes. Legacy bad links are never rewritten; completion of an activity whose linked intent is missing or foreign-scope is refused conservatively, while a same-scope cancelled intent keeps the stale-result rule.
- `requestExternalAction` always refuses unless a trusted authorizer was injected at construction; this version ships without such an adapter, so protected external actions are impossible by default.

### 5. Activity lifecycle

- Transition table: `pending → running|failed|cancelled`; `running → paused|stopping|failed|completed|unknown`; `paused → running|stopping|failed`; `stopping → cancelled|unknown`; `unknown → completed|failed|cancelled`; terminal states have no outgoing transition.
- Cancelling a running or paused activity enters `stopping`. Cancelling a `pending` activity is a safe local pre-start record. `unknown` work stays `unknown` when cancellation is requested; it is never mapped to cancelled.
- `stopping/unknown → cancelled` and `running/unknown → completed` require evidence **and** `trustedEvidence: true`, which only a trusted provider adapter may set. Model tool calls always pass `trustedEvidence: false`, and a `note` is never a substitute for evidence. A direct `stopping → cancelled` bypass is therefore rejected. Completion of work linked to a same-scope cancelled intent keeps `LIFE_STALE_RESULT` priority over the trust check.
- `completed` requires at least one evidence reference. Deadlines, time passing, and status polling never imply completion.
- A late completion for an activity linked to a cancelled intent is rejected with `LIFE_STALE_RESULT`; the activity and the intent remain unchanged.
- On plugin start, activities left in `running`/`stopping` by the previous owner are marked `unknown` (revision bumped) so they require explicit reconciliation; they are never auto-completed or replayed.

### 6. Storage failure policy

- A non-existent path initializes the schema and writes `schema_version = 2`.
- An existing path is verified first (`PRAGMA integrity_check`, `meta.schema_version`, required tables). Any failure throws `LifeStorageError`; the file is never replaced by a new empty store.
- At adapter startup a storage failure registers a `life` service whose `getHealth()` reports `state: 'unavailable'` and whose other methods fail closed with `LIFE_STORAGE`. The plugin does not crash the Host, and does not silently pretend state was loaded.
- A failed tick marks health `degraded` with `lastTickError`; a later successful tick clears it.
- Cleanup is registered before the service/tools are published, so a setup failure (duplicate service, tool registration error) releases the lease, clears the timer, and closes SQLite; the host and other plugins stay usable.

## Consequences and limits

- One process-local SQLite writer is sufficient for the first version; WAL allows independent readers/connections, and CAS prevents lost updates.
- Concurrency evidence: two independent connections claim a due intent exactly once sequentially, and a worker-thread barrier test on one initialized store produces exactly one event. Cross-process behavior under a real DSH process is not verified.
- No trusted external provider is installed. `trustedEvidence: true` is a host-code capability, currently exercised only by tests; model tools can never set it.
- The outbox is local-only. Consumers, if added later, must still dedupe by `eventId`, and must distinguish local acknowledgement from external completion.
- Schedule/Jobs are intentionally not integrated; a later authorization adapter may request wakeups through a trusted gateway, not by writing prompts directly.
- Codex independently installed the reviewed bundle through the real Plugin Manager, verified the live `ctx.life` service and all 9 registered tools, disabled/re-enabled it, and hard-restarted the isolated Desktop with persistence intact. Not verified here: real Schedule/Jobs interaction, cross-process contention under load, automatic DSH wake, and any external delivery.
- No license is granted by this document or the package; the repository license remains undecided.
