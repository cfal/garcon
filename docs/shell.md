# Shell Commands In Chat

Shell executes commands on the selected executor, using Sh, Bash, Zsh, or Fish
discovered on that executor's PATH. Linux and macOS
executors advertise Shell; Windows executors do not. No API profile, model,
credentials, or permission mode is involved. Commands run with the executor
account's privileges, not in a sandbox.

## Execution

Every submission starts a fresh process. Only the confirmed working directory
continues between commands. Variables, exports, functions, aliases, options,
and activated environments do not survive; combine dependent operations into
one multiline submission. Filesystem changes persist normally.

Non-login shell configuration loads on each invocation. Bash runs non-interactively
with alias expansion enabled and explicitly sources `~/.bashrc`; sections guarded
for interactive shells are skipped. Sh, Zsh, and Fish use interactive startup over
pipes, not a terminal. Startup output and errors are retained. Garcon restores
the confirmed directory after startup and disables Unix shell job control
before executing the submission. Terminal-dependent profile code may behave
differently or block.

Commands must contain well-formed Unicode and no NUL bytes. They are literal,
including whitespace, absolute executable paths, and
`@file` text. Automatic slash/snippet interpretation, preambles, attachments,
file expansion, and automatic resend are disabled. Explicit snippet insertion,
prose refinement, and title generation remain available. These are authoring
actions, not shell-aware validation; inspect their results before submitting.
Automatic chat titles use the same configured generation model and settings as
other chats. Title generation sends the first command to that model; it does not
rewrite the command or run the Shell integration as an AI model.

Schedules substitute `{{chat_id}}` using the usual template escaping rules.
Agent-created tasks and incoming automation are allowed without additional
Shell-specific checks. The user is responsible for supplying valid commands.
Printed output remains inert even when it contains Garcon control envelopes.

Shell chats can hand off to AI agents with retained command history and normal
carryover compaction. Handoffs into Shell, including executor transfers, are
rejected; new chats and draft selections can still choose Shell. Shell forks copy
the retained history and cwd, start a fresh native session on first submission,
and never execute the copied history. Shell has no native AI compaction action.
Carryover marks commands as literal input and preserves their whitespace within
its per-message bound. Publication loss adds a protected warning to carried
context, including after compaction; retained results do not imply complete output.
Handoff XML includes the same protected publication-loss warning.

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
unusable reported paths, and corrupt or unreadable reports, fail the turn and
pause the queue. Controller-side cwd settlement failures also retain a transcript
diagnostic across browser refresh and controller restart. An untouched report from a skipped footer retains the previous
confirmed path. `exec`, Stop, process termination,
and some shells' `exit` behavior may bypass the wrapper's observation.
The report is a best-effort observation, not a security boundary against commands
that modify it.

Nonzero status fails the turn and pauses waiting work, whether the failed
command was direct or queued. Stderr alone does not indicate failure. Status
follows the selected shell; Garcon does not add `errexit` or `pipefail`.
Shell chats do not send Telegram or browser attention notifications or play
completion sounds. Clean successful status rows are omitted from chat, shared
views, and search. Failures appear as compact errors; interruption, uncertain
outcomes, capture warnings, cwd warnings, and queue pauses remain visible.
Native history and exports retain every command result. Matching transient
error or warning notices are suppressed while the final durable result is
visible. A new submission clears previous transient notices, not historical
command results. Older derived search indexes rebuild automatically to remove
routine completion hits; transcript ledgers remain unchanged.

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
the last 64 KiB of combined stdout/stderr is held in memory until settlement,
then commits before publication. A crash during execution can lose that
in-flight output. Reload imports a bound native session; it
never replays commands or restores processes. Native literal inputs retain their
submission IDs and presentation so retries after Reload cannot repeat a recorded command
or conflict solely because a command was styled or collapsed.
A restart starts with the last
controller-confirmed directory, not an unapplied historical cwd observation.
Startup removes abandoned command-source workspaces. Deleting a native session
also removes its SQLite recovery sidecars.

- Output is incremental UTF-8 text, not lossless binary or terminal emulation.
- Each command retains only the last 64 KiB across both pipes, at UTF-8
  character boundaries. Older output is discarded with a truncation notice;
  truncation does not stop execution or fail a successful command.
- After process exit, output drain has a 1.5-second deadline. Held descriptors
  or stalled capture produce an explicit incomplete-capture outcome.
- No cumulative native-session or import row/byte quota is imposed. History
  grows until the chat is deleted; storage failures remain errors.
- Successful CLI receipts contain retained stdout and a notice when output was
  truncated, including an explicitly empty result for silent commands.
  Forwarded CLI receipt envelopes retain their existing 64 KiB limit, shortening
  optional output further with a notice when JSON encoding needs more room.
- Pipe ordering is preserved within each stream. Presentation groups stdout
  before stderr, without promising cross-stream ordering. Partial Markdown
  history windows, truncated output, or capture gaps render literally rather
  than interpreting an incomplete Markdown document.

## CLI

The existing opaque `--model` selection slot selects a shell family. Catalog
entries label the selection as "Shell":

```sh
garcon-cli list models --agent shell
garcon-cli start --agent shell --model bash --cwd /path/to/project 'pwd'
garcon-cli resume CHAT_ID 'cd subdirectory; ls'
```

The same operations work through an executor's loopback CLI gateway when its
controller CLI grant is enabled. Observed shell status is retained
in the transcript; CLI failure uses Garcon's ordinary failed-turn exit behavior.
