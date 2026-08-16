# Server Agent Compatibility Suite

SACS defines provider-neutral behavior once and runs it unchanged against every
server agent driver. Adding an integration means adding a thin driver, not
copying the assertions into another provider suite.

The suite treats the public server-agent interface as the product boundary.
Drivers may translate fixture controls into native provider actions, but they
must not contain expected transcript, lifecycle, or error assertions. Those
belong to the shared SACS cases.

## Required Modules

Every integration runs the interface module from
`@garcon/server-agent-interface/testing`. Integrations with a deterministic
scripted tier also run the SACS black-box modules in this directory. Cursor
remains unit-only by repository policy. Amp, Factory, and integrations without
a scripted binary run equivalent SACS operation modules at their strongest
non-live tier.

The universal transcript module covers:

- immediate input durability before provider dispatch;
- steering durability before provider delivery;
- exact observed transcript order across start and resume;
- one session fact on start and no new session fact on resume;
- no synthesized terminal or active run after process crash.

Capability modules apply whenever the corresponding nullable facet or emitted
event family is present:

- permission occurrence identity and exact response capability;
- native import, activity probe, and fork behavior;
- steering, goals, compaction, and project-path updates;
- shared-stream routing and per-chat sink-rejection isolation;
- source retirement and route/callback cleanup.

An advertised capability may not skip its module. A null facet records an
explicit not-applicable result. Provider-specific tests remain only for native
translation, native storage formats, and behavior unique to that provider.

## Driver Contract

`SacsDriverEnvironment` exposes fixture construction, start and resume request
creation, deterministic model scripting, request observation, and cleanup. A
driver establishes provider-native barriers and translates provider requests;
it does not choose an oracle.

The reference scripted drivers are Claude, Codex, OpenCode, and Pi. OpenCode's
real-binary tier is Linux-only. New reference-tier integrations register in
`drivers.ts`, after which every shared case runs automatically.

Transcript identity is always `(transcriptViewId, ordinal)`. Exact text checks
payload fidelity only. SACS never uses content, timestamps, fuzzy matching, or
substring counts as occurrence identity.
