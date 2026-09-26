# Server Agent Compatibility Suite

SACS owns provider-neutral contracts at two tiers. Interface conformance runs
against every shipped integration. The black-box modules in this directory run
unchanged against each registered scripted driver.

The suite treats the public server-agent interface as the product boundary.
Black-box drivers may translate fixture controls into native provider actions,
but they do not choose transcript, lifecycle, or error oracles.

## Executed Modules

Every shipped integration runs the conformance module from
`@garcon/server-agent-interface/testing`. It validates required service-facet
methods, nullable capability declarations and runtime shape, descriptor-value
uniqueness, settings invariants, lifecycle idempotence, and running-session
snapshot shape. The shipped-roster case observes idle snapshots; helper units
lock nonempty item shape and duplicate rejection.

`registry.test.ts` locks the required scripted-driver roster. Shared black-box
modules:

- `transcript-lifecycle.test.ts` covers immediate input and steering durability,
  duplicate non-redispatch, observed order, start/resume session facts,
  interrupt/successor behavior, and crash non-recovery;
- `legacy-history-adoption.test.ts` covers legacy absence, fail-closed import,
  quarantine, native missing/read-failure/valid-empty behavior, and the
  Direct/OpenCode source constraints represented by its registered drivers;
- `native-forking.test.ts` covers native point-fork fidelity for providers with
  that facet;
- `executor-disconnect.test.ts` runs only in remote lanes and drops the encrypted
  link with both processes alive. It covers detached native work, overlap
  rejection, manual Reload, and explicit followup without replay or duplicates.

Cursor remains unit-only by repository policy. Amp and Factory retain their
provider-owned strongest-tier tests; they do not run nonexistent equivalent
SACS operation modules.

## Ownership Boundary

Interface conformance validates advertised facet shape. It universally invokes
only `execution.runningSessions()` and an empty `settings.applyPatch`; it does
not infer provider behavior from capability presence. The shared black-box
modules own only the operations listed above.

Permissions, native activity probes, compaction, project-path
updates, shared-stream routing, source retirement, and route/callback cleanup
remain owned by CTS and provider scripted or unit tiers. Native translation,
storage formats, and provider-specific behavior remain provider-owned. A null
facet records that the capability is not advertised; it does not manufacture a
not-applicable behavioral result.

## Driver Contract

`SacsDriverEnvironment` exposes fixture construction, start and resume request
creation, deterministic model scripting, request observation, and cleanup. A
driver establishes provider-native barriers and translates provider requests;
it does not choose an oracle.

The reference scripted drivers are Claude, Codex, OpenCode, Pi, and the three
Direct integrations. OpenCode's real-binary tier is Linux-only. New
reference-tier integrations register in `drivers.ts`, after which every shared
case runs automatically.

Transcript identity is always `(transcriptViewId, ordinal)`. Exact text checks
payload fidelity only. SACS never uses content, timestamps, fuzzy matching, or
substring counts as occurrence identity.

## Remote Coverage

CI runs SACS in-process and in both public dial directions. Two additional
`test:remote-scripted` lanes run provider-specific permission, escalation,
queue, compaction, and shutdown suites with the pinned CLIs and synthetic model
endpoints. These are not paid/live-provider lanes.

`tests/server/executor-scripted-permission-loss.test.ts` additionally drops both
dial directions during a real Claude permission request. Transport-only tests
cover progressing 12 KiB/s links and silent half-open connections. Mixed
Files/Git/PTY pressure work is deferred pending the channel decision.
