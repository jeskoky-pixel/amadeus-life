# Life 1.0.1 isolated QQ external-wake verification (2026-10-27)

Status: bounded isolated verification, passed for the scenarios below. This was not a
production test and does not establish general autonomy or long-term reliability.

## Environment

- Official DSH Desktop and a real NapCat test Bot in an isolated Home/Profile.
  DSH Sessions and Life intents were synthetic; the QQ recipient was the user's
  explicitly authorized test account.
- No production profile, production database, or unrelated QQ conversation was
  accessed or modified.
- The behavioral test used the repaired runtime code in a uniquely named local
  QA tarball. The final Life 1.0.1 tarball contains that same runtime code; it
  was installed through DSH Plugin Manager and passed post-restart health/config
  checks. No npm publish or production deployment.

## What was tested

### 1. Initial attempt failed closed

- Reinstalling an updated tarball at the same plugin path did not replace the already
  installed 1.0.0 in this environment (same-version install/cache problem).
- With the stale runtime, the wake prompt derived external-message guidance from the
  wrong provenance (the wake/binding authorization string instead of the persisted
  intent). The wake executed, but the delivered prompt still told the model not to send
  external messages, and the model made zero QQ send calls.

### 2. Source repair plus fresh QA install

- The administrator Config set the flat `externalMessageSessionIds` field to the
  allowlisted Owner Session; the value was a subset of `allowedSessionIds`.
- A durable intent created by a model tool in that Session became due.
- The wake used the persisted current intent's tool provenance, so the prompt allowed
  considering the existing external tools within the current authorized private Scene.
- The model made exactly one `qq_send_message` call; Life recorded the wake as
  `executed` and the QQ tool returned `delivered`.
- NapCat `get_msg` and the owner's friend history independently showed the Bot's private
  text message.

### 3. Opt-in disabled

- After removing the entry from `externalMessageSessionIds` and restarting, a new
  tool-authorized intent wake executed with the explicit non-sending prompt.
- Zero QQ send calls were observed.

### 4. Final 1.0.1 package smoke

- The versioned 1.0.1 package installed into the isolated Desktop and loaded
  after a hard restart. Plugin Manager reported 1.0.1; Life health was `ok` and
  the flat external-message field reflected the disabled test setting.
- The final package was not used for a second external send, since the runtime
  code was unchanged from the positive and negative behavioral tests.

## Interpretation and limits

- The field changes only wake prompt guidance. It does not grant QQ permission or bypass
  tool/Scene authorization; the downstream QQ Scene allowlist and tool permissions remain
  hard boundaries.
- Verified in one isolated configuration with one authorized private Scene and one wake
  per condition. This does not demonstrate general autonomous messaging, group messaging,
  other Scenes, retry behavior, or long-term reliability.
- Deterministic regression tests cover persisted-intent provenance selection, default
  deny, administrator-created and idle prohibition, forged wake authorization, and
  fail-closed intent lookup/disagreement.
- No production changes were made; no production data is included in this report.
