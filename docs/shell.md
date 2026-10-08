# Shell Commands In Chat

Shell executes commands on the selected executor, using Sh, Bash, Zsh, Fish,
or PowerShell (`pwsh`) discovered on that executor's PATH. Linux and macOS
executors advertise Shell; Windows executors do not. No API profile, model,
credentials, or permission mode is involved. Commands run with the executor
account's privileges, not in a sandbox.

## Execution

Every submission starts a fresh process. Only the confirmed working directory
continues between commands. Variables, exports, functions, aliases, options,
and activated environments do not survive; combine dependent operations into
one multiline submission. Filesystem changes persist normally.

Usual non-login shell configuration loads on each invocation. Sh, Bash, Zsh,
and Fish use interactive startup over pipes, not a terminal. PowerShell uses
its normal profiles and `-File`. Startup output is retained. Garcon restores
the confirmed directory after startup and disables Unix shell job control
before executing the submission. Terminal-dependent profile code may behave
differently or block.

Commands are literal, including whitespace, absolute executable paths, and
`@file` text. Composer slash commands, snippets, preambles, attachments,
automatic resend, and conversational control messages do not alter or launch
commands. Shell makes no automatic AI calls for titles, refinement, or carried
history. Forks and handoffs retain visible history without executing it.

Stdout and stderr appear together after process exit and output draining, not
as live output. Both use separate fenced-code-style blocks by default. Prefix a
submission with `/md ` or `/markdown ` to render stdout through the normal
sanitized Markdown renderer. These prefixes are interpreted only by the Shell
integration; stderr always stays literal. Relative file links use the command's starting executor/directory,
not the chat's later directory. A command that changes directory before
printing relative links should print absolute paths instead.

## Completion And Stop

A wrapper observes the shell's final physical directory without parsing `cd` or
stdout. A valid changed path is checked and persisted before another queued
command can start. Failed commands can still change directory. Invalid or
unusable reported paths fail synchronization and pause the queue; missing
reports retain the previous confirmed path. `exec`, Stop, process termination,
and some shells' `exit` behavior may bypass the wrapper's observation.

Nonzero status fails the turn and pauses waiting work, whether the failed
command was direct or queued. Stderr alone does not indicate failure. Status
follows the selected shell; Garcon does not add `errexit` or `pipefail`.
PowerShell uses a conservative approximation: failed invocation, a newly
recorded error, or a nonzero native status fails the turn. A later successful
cmdlet does not necessarily clear an earlier failure, including a recovered
exception. Profile-stale native status is reset before source execution.
Scripts that modify `$Error` or `$LASTEXITCODE`, or ignore errors, can defeat
this observation. This is not an exact final-statement exit code.

There is no PTY or stdin UI. Stdin remains open and unwritten; prompts may
block until Stop. Stop sends group termination, then escalates after 500 ms.
This is best effort: daemonized descendants or commands that deliberately
change job control can escape. Completed side effects are not rolled back.
Background-job management is unsupported.

## Retention And Limits

Command input, stdout, stderr, and status are inert transcript records. Printed
Garcon envelopes cannot initiate controller actions. Records survive native
Reload, search, export, sharing, and frozen fork/handoff history.

Shell maintains private SQLite native logs under the executor's
`agent-data/shell/sessions-v1` directory. Commands commit before launch, and
output commits before publication. Reload imports a bound native session; it
never replays commands or restores processes. A restart starts with the last
controller-confirmed directory, not an unapplied historical cwd observation.

- Output is incremental UTF-8 text, not lossless binary or terminal emulation.
- Each command captures at most 16 MiB across both pipes, in 32 KiB batches.
- After process exit, output drain has a 1.5-second deadline. Held descriptors
  or stalled capture produce an explicit incomplete-capture outcome.
- Each native session allows 60 MiB of serialized records or 100,000 rows.
  Exhaustion fails explicitly; history is never silently pruned.
- Successful CLI receipts contain complete stdout up to 4 MiB, including an
  explicitly empty result for silent commands. Larger results have no final
  receipt text; use transcript export. Forwarded CLI receipt envelopes retain
  their existing 64 KiB limit.
- Pipe ordering is preserved within each stream. Presentation groups stdout
  before stderr, without promising cross-stream ordering. Partial Markdown
  history windows or capture gaps render literally until a complete document
  is available.

## CLI

The existing opaque `--model` selection slot selects a shell family. Catalog
entries label it as an execution variant, not an AI model:

```sh
garcon-cli list models --agent shell
garcon-cli start --agent shell --model bash --cwd /path/to/project 'pwd'
garcon-cli resume CHAT_ID 'cd subdirectory; ls'
```

The same operations work through an executor's loopback CLI gateway when its
controller CLI grant is enabled. Observed shell status is retained
in the transcript; CLI failure uses Garcon's ordinary failed-turn exit behavior.
