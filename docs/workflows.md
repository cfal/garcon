# Workflow Execution Contracts

Workflows remains disabled by default. The engine, repository preparation and
evidence components are implemented as internal modules; production dispatch,
publication, resource adoption/removal and the workflow UI are not yet connected.
Ordinary chats do not depend on workflow storage.

## Repository Inputs

Every repository target declares its executor, existing clone, logical repository
identity, approved root commit and explicit managed `worktreeRoot`. The root must
already exist outside a Git checkout and use the executor's canonical path spelling. Paths
are interpreted and checked on the selected executor, including Local.

Agent and command targets also declare `inputTaskId`, either null to start at the
approved root or a direct dependency that produces a commit. Reservation selects
exactly one current, passing, clean, runtime-observed commit artifact from that
dependency. The plan keeps its root commit; the attempt binds the selected commit.
The input digest includes the dependency artifact identities and digests. Missing
or ambiguous evidence blocks admission rather than choosing an arbitrary SHA.
Publication selects its input through `sourceTaskId` with the same exact-artifact
rules; it never checks a source review against the plan's older root commit.

Preparation verifies ancestry to the approved root, persists an operation intent
and exclusive resource claim, then creates a new managed branch/worktree through
the selected Git runtime. The clean creation identity, runtime instance and tree
are retained. Unknown creation quarantines its resource and is never replayed.
Commit objects must already be available in the selected clone: transfer
orchestration is a separate, not-yet-connected step, never an implicit fetch.

## Evidence Acceptance

An exact terminal first records bounded execution facts. Its runtime identity
comes from the matched producer binding, not current executor discovery. That
identity is process-local command metadata; no execution attribution is added to
durable transcript rows. Missing runtime identity cannot certify workflow output.

Read-only output capture runs after core execution ownership releases and while
the automation control lease remains held. The adapter checks managed ownership,
HEAD, cleanliness, raw commit identity and input ancestry. Final acceptance
rechecks current generation, dependency artifacts, holds, resource ownership,
persisted control and live revocation/shutdown fences in the same transaction as
evidence, resolution and claim settlement. Pause and feature-disable do not
prevent already-admitted work from settling. Stop, takeover and stale generations
cannot become automatic success.

Command evidence evaluates the persisted structured outcome, not receipt success
or assistant text. Passing requires the expected exit code, no signal, the exact
reported managed directory and a clean unchanged input. Shell reports its final
directory; the captured effective input identifies its launch directory. A full-log
check additionally requires complete executor capture and controller delivery.
Explicit exit-status-only checks may tolerate missing logs but retain that
disclosure. A known wrong exit or signal remains failure when logs are incomplete;
missing required observations remain unknown and are not automatically retried.

Agent commit outputs come only from the observed clean HEAD and must advance the
input commit with verified ancestry. A completed turn with no new commit fails.
SHA strings in prose do not establish output identity. Summaries and review
verdicts remain agent-asserted. Reviews leave the selected input unchanged and
return one bounded JSON object with exactly `commit`, `decision` (`accept` or
`reject`) and `summary`; the reported commit is compared with the independently
observed input. These instructions are composed before effective-input hashing.
Reviews cannot also produce a commit. Review/approval dependencies constrain
existing inputs, not commits that a future producing task has not created yet.
Independent reviews select the same repository, approved root and input task as
their consumers. Gates are checked before dispatch and again at acceptance.
Rejected reviews do not automatically retry; another review requires an explicit
operator decision. Commit-output instructions require a clean commit on the
current branch. An empty commit advances HEAD and can satisfy commit presence;
content quality remains the responsibility of declared checks and review.

Evidence records endpoint observations, not continuous filesystem isolation.
Ignored files, environment/toolchain changes, hooks, custom merge drivers and
same-account background writers remain trusted. A clean before/after pair does
not prove the filesystem was unchanged throughout execution. Complete logs remain
in ordinary chat storage; bounded workflow evidence survives independently of
transcript navigation availability.

The workflow store format is version 2. Earlier development stores are rejected
without migration or rewriting; adding explicit roots is an approval change, not
a value the controller can infer for an existing plan.
