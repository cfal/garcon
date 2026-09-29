# Executor UI And Ticket Defaults

Status: implemented. This document began as a 2026-09-23 discussion summary and now describes the shared executor selector, executor-scoped directory and model choices, and executor-resolved ticket project defaults.

## Shared Executor Selector

Reuse the [executor selector](../../web/src/lib/components/shared/ExecutorSelector.svelte) already shared by Files and Git rather than introducing another independent picker.

- Keep the existing Network icon and semantic theme color.
- For the chat composer, match the model selector's height, spacing, rounding, and hover treatment.
- Use available container width for responsive behavior, including narrow desktop panels.
- Retain the existing visibility policy: hide when Local is the only configured executor. Configured offline executors still count; a retained unavailable selection must remain visible.
- Keep availability specific to the operation. Selecting an execution target must not require Files or Git support. Offline or unsupported targets must never silently fall back to Local.

## New Chat And Scheduled New Chat

Executor selection sits beside the project directory rather than in the model picker:

- Wide layout: executor selector to the left of the directory field.
- Narrow layout: executor selector above the directory field, retaining its full label.
- Scheduled New Chat uses the same arrangement.
- Directory browsing, Tab completion, pinned/recent paths, worktrees, and model discovery are scoped to that executor.
- The model picker is fixed to the selected executor. Neither its ordinary options nor its recents switch executors implicitly.

Changing the executor chooses the destination's saved default or most recent directory, falling back to its advertised project base. Prompt text and attachments are preserved. An agent/model selection is kept only when valid on the destination, and submission requires a validated destination catalog.

The scheduled prompts list shows each prompt's executor as a pill: the executor a new chat will start on, or the current executor of an existing chat. A prompt whose chat no longer exists shows no pill, and the pill is hidden while Local is the only executor.

## Chat Composer

A separate executor selector sits immediately to the left of the model selector. The composer's model picker does not select executors, and its trigger carries no executor prefix.

In narrow composers the executor trigger collapses to its icon. Pressing it opens a menu containing full executor names, availability, and the selected item. The trigger keeps an accessible selected-executor label and a desktop tooltip.

Handoff behavior:

- Choosing another executor opens destination configuration rather than immediately moving the chat.
- Confirm the destination directory with that executor's pinned folders, a pin toggle, a live folder check, browsing through its Files service, and worktree selection when the folder is a Git repository. "Use This Executor" stays disabled until the folder validates on the destination, and the folder is checked again on confirmation.
- Keep the current agent/model when supported; otherwise require an explicit replacement on the destination, and say so while the destination catalog lacks the selection.
- Cancel leaves the prior selection unchanged. Confirmation commits the complete destination through the promptless handoff command without sending a prompt or consuming the composer draft.
- Switching agents on the same executor while the chat's folder is known to be unavailable opens the same dialog to choose a folder, since some agents cannot update their project path.
- Do not implicitly stop a turn, discard queued input, or migrate project files.

Executor, directory, agent, and model must not be published as a partially valid destination configuration.

## One-Shot Model Preferences

Title generation, commit-message generation, and other one-shot preferences keep executor selection inside the model picker, as its leftmost desktop column:

```text
Executor | Agent | Provider | Model | Effort
```

The executor column appears once a remote executor is configured or the saved selection is not Local. Other columns remain conditional on the selection's capabilities. New Chat, scheduled New Chat, and the chat composer omit the executor column because their enclosing UI owns executor selection.

In the compact picker, Executor is a pane rather than an additional column squeezed onto a small screen. Draft selection and cancellation behavior are preserved when navigating between panes.

Generation placement is independent of project placement. In particular, selecting a commit-message model on executor B does not move Git operations from repository executor A. Auto generation always runs on Local.

## Remaining Directory Pickers

- Scheduled New Chat gates browsing and completion on Files capability and passes the selected executor into the directory browser.
- Preamble path rules keep per-rule executor selection with the shared selector styling, and browse against that rule's executor and project base instead of the controller's directory.
- The composer handoff's destination picker uses the same executor-qualified browser.

Executor changes must cancel or invalidate obsolete directory, worktree, and catalog requests. Results remain bound to the captured executor/path even when identical path strings exist on multiple executors. Manual path entry and its validation/error states remain available when browsing is unavailable.

## Ticket Project Defaults

Ticket projects remain global, editable labels, not executor-owned filesystem identities. Automatic defaults are repository names rather than full paths:

- `/work/repo` defaults to `repo`.
- Subdirectories and linked worktrees use the primary checkout's directory name, not the linked worktree's folder name.
- Non-Git directories use their folder name.
- The owning executor resolves the directory and repository and returns the name as the suggested project label.
- Identical names intentionally share a ticket project across executors. Users can supply distinct labels for unrelated repositories with the same name, or a common label for differently named clones.
- Defaults carry no executor prefix, identity is not inferred from Git remote URLs, and there is no project-mapping system.
- Explicit project labels bypass automatic inference. The rule does not rewrite existing ticket labels; it applies only to automatic defaults for new tickets.

The [controller resolver](../../server/controller/tickets/project-default.ts) asks the owning executor through the typed `ticketProjectDefault` project-service query, which [resolves the name on that machine](../../server/runtime/projects/ticket-project-default.ts). It preserves primary-checkout grouping, executor-local filesystem boundaries, bounded probing, cancellation, and directory fallback. The Git `getRepoInfo` result alone is insufficient because it describes the current worktree rather than necessarily identifying the shared primary checkout.

The browser and controller-handled agent commands use the same resolver. Executor unavailability never triggers controller-local inspection. If no usable default can be produced, explicit project entry remains. Ticket storage and CRUD remain controller-owned and do not depend on executor availability.

Changes to these flows should be verified across narrow and split-panel layouts, long executor names, unavailable executors, failed catalog refreshes, cancelled handoffs, rapid executor changes, and stale same-path responses. Ticket changes should cover linked worktrees, ordinary folders, matching names across executors, explicit overrides, and preservation of existing labels.
