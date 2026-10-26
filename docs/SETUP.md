# Life setup — one screen

Life stays off until an administrator enables it. This page is the short path; all fine-grained fields are in the Advanced table at the end (README has the full list).

## 1. Pick one starting mode

| Mode | What runs | Safe default |
|---|---|---|
| **Core only** | Intents, activities, health, local reconsideration events | no Host wake, no idle, no autonomous model calls, no new activity/shared tools; no identity bootstrap |
| **Autonomous** | Core + Host due/idle wake for selected Sessions + persistent wake/token/activity budget | delivery enabled only for the allowlisted Sessions; idle for the first one; local bootstrap creates the default identity |
| **Local activity** | Core + local virtual Provider model tools (`start/status/pause/resume/cancel/finish`) | Host wake/idle stay off; local bootstrap creates the default identity |

You can combine autonomous + local activity later by editing the generated JSON; keep both explicit.

## 2. Generate the config

From this repository:

```powershell
node scripts/life-setup.mjs --preset core
node scripts/life-setup.mjs --preset autonomous --sessions <session-id-1>,<session-id-2>
node scripts/life-setup.mjs --preset activity --sessions <session-id>
```

Write the JSON without touching any profile:

```powershell
node scripts/life-setup.mjs --preset autonomous --sessions <session-id> --out life-config.json
```

The helper only validates and prints/writes plain JSON using the same flat Config fields as DSH Config Forms/Plugin Manager. It never reads secrets, edits `package.json`/`cordis.patch.yml`, binds a Session, or enables anything. `--out` uses exclusive create (`wx`): it creates a **new** file at your chosen path and refuses to overwrite an existing file.

Autonomous/activity presets include `bootstrapEnabled: true` and `bootstrapPersonaName: 'Amadeus'`. On first activation Life creates one stable default Persona, one private Scene per allowlisted Session, and one binding per Session. The second load with the same config performs no writes and does not increment binding revision. If a Session already has a different Persona/Scene binding, activation fails closed with `setup.state: 'failed'`; Life never rebinds or overwrites history. Core-only does not bootstrap anything.

## 3. Put it on the Life plugin row

In **DSH Config Forms / Plugin Manager**, set the flat Life fields on the `amadeus-life` row, or use the generated object as the row `config`. The administrator-facing flat fields are `wakeDeliveryEnabled`, `allowedSessionIds`, `externalMessageSessionIds`, `wakeIntervalSeconds`, `bootstrapEnabled`, and `bootstrapPersonaName`; the Settings form shows these same names. Do not hand-edit a production profile; use the administrator's normal install/update path. The `databasePath` is optional; leave it default unless the administrator has a reason to move the SQLite file.

`allowedSessionIds` is an **allowlist**: only these DSH Session ids can receive Life wake/idle delivery. Copy ids from the Session list; a wrong or empty list keeps autonomous delivery degraded/off. Never paste credentials or private content into config.

The optional flat `externalMessageSessionIds` defaults to `[]` and must be a subset of `allowedSessionIds` (every entry must also appear in the allowlist). Only an intent wake in one of those Sessions whose persisted current intent has model-tool provenance (`authorizationRef` = `life-tool:session:<targetSessionId>`) gets prompt guidance that existing external tools may be used; the Host reads that persisted intent, not the wake row or the Session binding string. Idle wakes and administrator-created intents still prohibit external messaging. This field changes only the wake prompt: it does not grant QQ permission, and the downstream QQ Scene allowlist and tool permissions remain authoritative. Enable it only for a deliberately authorized Session.

Legacy programmatic nested config (for example `wakeDelivery.allowedSessionIds`) is still accepted for compatibility, but it is not the administrator UI; use the flat fields above in DSH.

## 4. First-run identity (automatic bootstrap)

For Autonomous and Local activity, no manual Host JS is required: the generated `bootstrap` config creates the stable default Persona/private Scenes/bindings once. Private Scenes are never shared automatically.

If you intentionally need a custom Persona/Scene, leave `bootstrap` disabled and use the trusted admin-only `ctx.life` path:

```js
const persona = ctx.life.createPersona({ name: 'Amadeus' })
const scene = ctx.life.createScene({ personaId: persona.id, contextScope: `session:${sessionId}` })
ctx.life.bindSession({
  targetSessionId: sessionId,
  personaId: persona.id,
  sceneId: scene.id,
  principalId: 'admin:<id>',
  authorizationRef: 'admin:approved',
})
```

These operations are not model tools. A Session cannot switch Persona/Scene in place; use a new Session. Revocation (`revokeSessionBinding`) invalidates pending wakes and Session-owned activities; Scene grants can be revoked with `revokeSceneShare`. If bootstrap collides with a custom binding, keep the custom binding or use a new Session; never overwrite it.

## 5. Check health

```js
ctx.life.getHealth()
```

| Symptom | Meaning |
|---|---|
| `delivery.state: 'disabled'` / `reason: 'not_enabled'` | normal when wakeDelivery is off |
| `reason: 'no_allowed_sessions'` | enabled but allowlist empty |
| `reason: 'awaiting_services'` / `missing_capability` | optional DSH Host services or listener are unavailable |
| `reason: 'reconciliation_unavailable/pending/unresolved'` | old wakes need exact Session/message evidence; no resend is attempted |
| `setup.state: 'failed'` / `reason: 'bootstrap_failed'` | bootstrap hit a different existing Persona/Scene; no rebind occurred. Keep the existing binding or use a new Session. |
| tool error `active Session binding is required` | bootstrap is off and no manual admin binding exists |
| tool error `activity concurrency limit` | budget is full; finish/cancel an activity or ask admin to raise the limit |
| `usage_unknown` | no official usage field was present; conservative reservation remains |
| `cost budget is not configured` / `exhausted` | paid reservation interface is not configured or full; no real payment is attempted |

## 6. Advanced (only if needed)

- Full config table: [README](../README.md#配置)
- Install/upgrade: [INSTALL](INSTALL.md)
- Safety boundaries and failure behavior: [ADR 0006](adr/0006-life-v1-identity-idle-budget-provider.md), [ADR 0007](adr/0007-activity-concurrency-paid-reservation.md), [ADR 0008](adr/0008-life-v1-final-hardening.md)
- Ten-scenario test mapping: [V1_TEN_SCENARIOS](verification/V1_TEN_SCENARIOS.md)

Autonomous delivery and activity/shared tools are **off by default**. No platform messages, payments, publication, or external Provider calls are implemented.
