# Execution Node UI And Ticket Defaults

Discussion summary, 2026-09-23. This document records the requested UI changes, agreed ticket defaults, and recommended interaction details. It does not indicate implementation completion.

## Shared Node Selector

Reuse the [execution-node selector](../../web/src/lib/components/shared/ExecutionNodeSelector.svelte) already shared by Files and Git rather than introducing another independent picker.

- Keep the existing Network icon and semantic theme color.
- For the chat composer, match the model selector's height, spacing, rounding, and hover treatment.
- Use available container width for responsive behavior, including narrow desktop panels.
- Retain the existing visibility policy: hide when Local is the only configured node. Configured offline nodes still count; a retained unavailable selection must remain visible.
- Keep availability specific to the operation. Selecting an execution target must not require Files or Git support. Offline or unsupported targets must never silently fall back to Local.

## New Chat And Scheduled New Chat

Move node selection out of the model picker and place it beside the project directory:

- Wide layout: node selector to the left of the directory field.
- Narrow layout: node selector above the directory field, retaining its full label.
- Apply the same arrangement to scheduled New Chat.
- Scope directory browsing, Tab completion, pinned/recent paths, worktrees, and model discovery to that node.
- Make the model picker fixed to the selected node. Neither its ordinary options nor its recents may switch nodes implicitly.

Recommended node-change behavior: retain the current New Chat policy of choosing the destination's saved default/recent directory, falling back to its advertised project base. Preserve prompt text and attachments. Keep an agent/model selection only when valid on the destination, and require a validated destination catalog before submission.

## Chat Composer

Add a separate node selector immediately to the left of the model selector. Remove node selection from the composer's model picker and remove the redundant node prefix from its model trigger.

On narrow layouts, collapse the node trigger to the execution-node icon. Pressing it opens a menu containing full node names, availability, and the selected item. Preserve an accessible selected-node label and a desktop tooltip.

Recommended handoff behavior preserves the existing staged ownership flow:

- Choosing another node opens destination configuration rather than immediately moving the chat.
- Confirm the destination directory, with browsing through that node's Files service.
- Keep the current agent/model when supported; otherwise require an explicit replacement on the destination.
- Cancel leaves the prior selection unchanged. Confirmation stages a complete destination selection; the next submission performs the handoff through the existing admission path.
- Do not implicitly stop a turn, discard queued input, or migrate project files.

Node, directory, agent, and model must not be published as a partially valid destination configuration.

## One-Shot Model Preferences

Keep node selection inside the model picker for title generation, commit-message generation, and other one-shot preferences, but replace the top dropdown with the leftmost desktop column:

```text
Node | Agent | Provider | Model | Effort
```

Other columns remain conditional on the selection's capabilities. New Chat, scheduled New Chat, and the chat composer omit the node column because their enclosing UI owns node selection.

Recommended compact behavior: make Node a pane in the existing compact picker instead of squeezing additional columns onto a small screen. Preserve draft selection and cancellation behavior when navigating between panes.

Keep generation placement independent of project placement. In particular, selecting a commit-message model on node B does not move Git operations from repository node A. Preserve the existing Auto generation behavior.

## Remaining Directory Pickers

- Scheduled New Chat: replace the remaining Local-only browsing and completion guards with Files capability checks, and pass the selected node into the directory browser.
- Preamble path rules: retain per-rule node selection, reuse the shared selector styling, and enable browsing against that rule's node and project base instead of the controller's directory.
- The composer handoff's destination picker should use the same node-qualified browser.

Node changes must cancel or invalidate obsolete directory, worktree, and catalog requests. Results remain bound to the captured node/path even when identical path strings exist on multiple nodes. Preserve manual path entry and existing validation/error states when browsing is unavailable.

## Ticket Project Defaults

Ticket projects remain global, editable labels, not node-owned filesystem identities. Change automatic defaults from full paths to repository names:

- `/work/repo` defaults to `repo`.
- Subdirectories and linked worktrees use the primary checkout's directory name, not the linked worktree's folder name.
- Non-Git directories use their folder name.
- Resolve the directory and repository on the owning node, then return the name as the suggested project label.
- Identical names intentionally share a ticket project across nodes. Users can supply distinct labels for unrelated repositories with the same name, or a common label for differently named clones.
- Do not add node prefixes, infer identity from Git remote URLs, or introduce a project-mapping system.
- Explicit project labels bypass automatic inference. Existing ticket labels remain unchanged; the new rule affects automatic defaults for new tickets.

Extract the existing best-effort [project resolver](../../server/tickets/project-default.ts) behind a narrow typed node project-service query. Preserve primary-checkout grouping, node-local filesystem boundaries, bounded probing, cancellation, and directory fallback. The current Git `getRepoInfo` result alone is insufficient because it describes the current worktree rather than necessarily identifying the shared primary checkout.

Use the same resolver for the browser and controller-handled agent commands. Node unavailability must not trigger controller-local inspection. If no usable default can be produced, retain explicit project entry. Ticket storage and CRUD remain controller-owned and do not depend on node availability.

## Implementation Grouping

Keep the work reviewable in separate changes:

1. Shared selector presentation and explicit fixed-node versus selectable-node model-picker modes.
2. New Chat, scheduled New Chat, preamble browsing, and composer handoff integration.
3. One-shot desktop columns and compact navigation.
4. Node-side ticket default resolution and repository-name suggestions for both Local and remote nodes.

Verification should cover narrow and split-panel layouts, long node names, unavailable nodes, failed catalog refreshes, cancelled handoffs, rapid node changes, and stale same-path responses. Ticket coverage should include linked worktrees, ordinary folders, matching names across nodes, explicit overrides, and preservation of existing labels.
