# Shell Commands And Notes In Chat

Shell executes commands on the selected executor, using Sh, Bash, Zsh, or Fish
discovered on that executor's PATH. Linux and macOS
executors advertise Shell; Windows executors do not. No API profile, model,
credentials, or permission mode is involved. Commands run with the executor
account's privileges, not in a sandbox.

## Notes

The **Mode** selector also offers **Notes** (plain text) and **Notes (Markdown)**
(sanitized Markdown). Both save the exact submitted text to Shell's native
history without launching a process, loading shell startup files, changing cwd,
or producing an assistant response. Formatting is stored per message: switching
modes does not restyle saved notes. Copy returns the original source.

Notes requires the selected executor and project just like command modes, but
does not require an installed shell. It is not an offline notepad. The existing
automatic AI-title setting applies: when enabled, the first note is sent to the
configured title-generation model. Explicit title generation and prose refinement
also remain available.

Literal-input rules still apply to both formats. `/md`, `/markdown`, shell syntax,
and Garcon control envelopes are note text. The app commands listed below are
intercepted in both Notes formats. Attachments and automatic preambles remain disabled.
Native Reload restores saved notes and their original formats.

Changing modes requires an idle chat with no queued user or control input.
This prevents a queued note from becoming an executable command. A per-run
model override affects only that turn, not the saved mode or subsequent queue.

## Execution

Every command submission starts a fresh process. Only the confirmed working directory
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
`@file` text. Provider slash-command and automatic snippet interpretation, preambles, attachments,
file expansion, and automatic resend are disabled. Explicit snippet insertion,
prose refinement, and title generation remain available. These are authoring
actions, not shell-aware validation; inspect their results before submitting.
Automatic chat titles use the same configured generation model and settings as
other chats. Title generation sends the first command to that model; it does not
rewrite the command or run the Shell integration as an AI model.

Schedules substitute `{{chat_id}}`, `{{current_date}}` (UTC), and
`{{current_date_local}}` (controller-local timezone) using the usual template
escaping rules. Both dates use `YYYY-MM-DD` at dispatch, not the executor's clock.
Existing-chat schedules capture the mode and owner when saved; changing either
causes the scheduled run to fail rather than reinterpret a note as a command.
The user is responsible for supplying valid commands.
Printed output remains inert even when it contains Garcon control envelopes.

## App Commands

The composer recognizes `/rename TITLE`, `/move top|bottom`, `/tag add|rm TAGS`,
`/in DURATION TEXT`, bare `/fork`, and confirmed `/clear`. These actions run on
the controller, including when the selected executor is unavailable and its
capabilities are still known. Fork copies
retained history without submitting new input; `/fork TEXT` remains literal.

Names must be lowercase at column zero and followed by ASCII whitespace or the
end of input. `/fork` and `/clear` accept only trailing whitespace. Leading
whitespace escapes app interpretation. Other forms, including `/compact`,
`/handoff`, `/steer`, `/md`, and `/markdown`, remain literal. Provider commands
and skills are not discovered. CLI input, automatic initial input, printed output,
and Reload never trigger these composer actions.

`/in 5m TEXT` saves a one-off input, not a notification. Durations use ordered
`d`, `h`, and `m` units, from one minute through 365 days; the requested time
rounds up to a minute. After the duration, one whitespace separator (including
a CRLF pair) is consumed; all remaining payload whitespace is preserved.
Absolute paths and `/md` prefixes are allowed. The payload is not recursively
interpreted as an app command: `/in 5m /clear` sends literal `/clear` to Shell.

At firing, normal schedule templates expand and the input uses the chat's
current confirmed working directory. Busy or paused chats skip the occurrence;
missed, skipped, and failed occurrences are not retried. Only the eventual input
enters native history, not the `/in` wrapper. The captured mode and owner must
still match. Editing a schedule does not retarget that capture; recreate it to
use a different mode. See [Scheduled prompts](scheduled-prompts.md).

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

## Clearing The Displayed History

In a Shell chat's composer, standalone `/clear` opens Garcon's confirmation
dialog. Other agents reject this app command rather than forwarding it to their
native command handling. It clears the current ledger transcript, not the agent's
native history or context. It never launches a shell process, stops a command,
or removes queued work. Finish active work and run or remove queued inputs first.

The user-message menu also offers **Clear before message**, including in Notes
modes. Confirmation keeps the selected message and all later history while
removing earlier ledger rows. It never clears the composer draft. Only saved
user messages can be selected, not pending inputs or command output. Both Clear
actions pin the displayed view and head; a changed transcript requires a fresh
selection and confirmation.

The command must be lowercase at the beginning of the input, with only optional
trailing ASCII whitespace. `/clear argument`, `/clear; pwd`, `/clear` followed
by another command, ` /clear`, `/Clear`, and `/md /clear` remain ordinary input.
Printed `/clear` is inert. CLI `resume CHAT_ID '/clear'` is ordinary agent input,
not the confirmed composer action.

Clear removes old content from chat search, future exports and future
ledger-derived handoff context. It also removes inherited fork history that has
not yet been sent to an agent. Established native context, session identity,
settings and cwd remain unchanged. Manual Reload may restore the current native
session's available history, but cannot restore Garcon-only or inherited rows;
it is not an exact Undo. Existing shares, forks, downloaded exports and command
filesystem effects are unaffected.

If Clear cannot be confirmed because the connection failed, Garcon checks for
a replacement view without retrying the mutation. Refresh and inspect the chat
before issuing another Clear. Delete Chat remains the way to delete the chat
and release its native session. Neither operation promises secure erasure of
previously retained copies.

## CLI

The existing opaque `--model` selection slot selects a shell family or Notes
mode. Catalog entries label the selection as "Mode":

```sh
garcon-cli list models --agent shell
garcon-cli start --agent shell --model bash --cwd /path/to/project 'pwd'
garcon-cli resume CHAT_ID 'cd subdirectory; ls'
garcon-cli start --agent shell --model notes --cwd /path/to/project 'A plain note'
garcon-cli start --agent shell --model notes-markdown --cwd /path/to/project '# A Markdown note'
```

The same operations work through an executor's loopback CLI gateway when its
controller CLI grant is enabled. Observed shell status is retained
in the transcript; CLI failure uses Garcon's ordinary failed-turn exit behavior.
