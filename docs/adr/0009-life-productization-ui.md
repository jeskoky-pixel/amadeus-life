# ADR 0009 — Life productization: native Settings, one Config, minimal admin API

Status: accepted for 1.0.0 productization.

## Context

Life had a stable Host runtime but setup depended on JSON/admin JS. The product requirement is a normal DSH Desktop user finding **Amadeus Life** in Settings, seeing health/identity/activity state, changing common parameters, saving, and continuing after restart. The existing runtime, CAS, budgets, Provider evidence, and trust boundaries must not be redesigned.

## Decision

1. Export a dependency-free Standard Schema `Config` with 23 flat **volatile** fields. DSH `dsh-settings` projects only volatile fields; volatility is why the `amadeus-life` namespace appears in the Config Forms describe mirror. The Settings page, row Configure page, and Plugin Manager form use this single authority. Operational fields are restart-scoped; the UI states that explicitly.
2. Ship a lazy-CJS browser module (`./client`) registering `settings.section` only while Config Forms serves `amadeus-life`. It also registers `plugins.row.config` (`@amadeus/life#amadeus-life`) and `plugins.detail.section` basic-config card, sharing the same form/revision. It renders Overview, First run, Sessions, Intents, Activities, Budget, and Advanced/Diagnostics.
3. Add a minimal owner-authenticated same-origin HTTP API under `/api/amadeus-life`. It requires DSH `connection.admit` owner admission and the Life marker header for writes. It exposes bounded reads and bootstrap/binding revoke/intent cancel/activity pause-resume-cancel. It never exposes SQLite to the browser and never offers a direct `completed` transition.
4. Sessions are never enumerated or invented. The allowlist is explicit; unknown/private binding details remain controlled by the existing identity service.
5. First-run presets are flat Config fields. `bootstrapEnabled` remains off by default and preserves the existing stable-ID/idempotent/fail-closed behavior. The GUI may call the bootstrap endpoint after saving the allowlist, but the config path remains authoritative.
6. The build produces `lib/client.js`; `npm run package` writes a versioned tarball, SHA-256, and metadata locally. No publish/install/profile mutation is part of the scripts.

## Consequences

- The client is optional: a Host without web/Connection services still runs, with the page showing a disconnected error.
- A saved setting that changes wake/idle/budget construction may require plugin restart; the page labels these fields.
- Real browser installation, click-through, and visual acceptance remain Codex's isolated-DSH task. Local tests validate schema/normalization, client compilation/registration, API auth/contracts, and package contents.
