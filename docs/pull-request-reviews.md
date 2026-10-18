# Pull Request Reviews

Garcon reviews pull requests in connected GitHub repositories with ordinary
chats and keeps each review's final response. Design discussion:
[cfal/garcon#897](https://github.com/cfal/garcon/issues/897). This page
describes what milestones 1 and 2 of that issue implement.

The global inbox stays accessible from GitHub Views on desktop and Open PRs
in the mobile chat menu, regardless of the current chat's executor or GitHub
login. Repository connection and scan errors appear inside the inbox.

Connected repositories are also available directly in **Settings → GitHub**,
below the executor's GitHub CLI status. Settings and the inbox's Repositories
dialog share the same controls for connecting, editing, scanning, disconnecting,
and viewing recent reviews. Connections with matching names on different hosts
show their host in the manager, inbox, filters, and recovery list.

## Loop

1. **Connect.** A repository is an executor and a folder that is a checkout of
   a GitHub repository, plus the new-chat selection (agent, model, permission
   mode, effort, tags, preambles) its reviews start with. Connecting runs
   `gh` on that executor to resolve `owner/name` and the login it acts as. A
   folder that is not a checkout, or the same host and repository already
   connected on the same executor, is refused. Matching owner/name pairs on
   different GitHub hosts are separate connections.
2. **Scan.** Every 5 minutes, and at once after a connect, edit, or Scan now,
   the controller lists the repository's open pull requests through the
   executor's `gh`. An unreachable executor marks the repository paused and
   keeps its last list; it is never shown as having no pull requests.
   Up to four repositories scan independently, with one scan per repository.
   Scan now requests take the next available slot and coalesce while that
   repository is already scanning.
3. **Select.** With automatic review on, a pull request is reviewed when it
   passes the repository's filters, has no finished or running review of its
   current head, has not used its attempts at that head, was not stopped by
   the user at that head, and its head has been unchanged for the debounce
   period, measured from when the scanner first saw it. The daily limit
   counts automatic reviews started in the last 24 hours, with queued reviews
   reserving available starts. Interrupted reviews that never started use no
   attempts or daily allowance. Saving repository settings cancels queued
   automatic reviews; each automatic review also rechecks the current policy
   immediately before starting. Manual reviews remain independent of filters.
4. **Start.** At most two reviews run at once, one per repository. A review is
   a new chat in the repository's folder, tagged `auto-review` and named
   `Review owner/name#N`, started with the repository's prompt. A push during
   an active review waits for that review to finish before another is queued;
   other pull requests continue through selection on that scan.
5. **Collect.** When the turn ends, its final response is stored as the
   review. The review must contain exactly one `Reviewed commit: <sha>` line;
   without one the run fails and keeps the text. A review whose commit is no
   longer the head is outdated.
6. **Post.** Reviews stay in Garcon by default. The repository's
   **Post reviews to GitHub automatically** checkbox starts unchecked. Checking
   it publishes completed reviews for that repository automatically; leaving
   it unchecked keeps the **Post to GitHub** button available on each review.

Review chats are ordinary chats. Stopping one stops its review; deleting one
ends it. Deleting a completed review chat removes its Open Chat action while
preserving the saved review. When a pull request leaves the open list, its review chats are
archived.

## Posting

The controller posts, never the agent, through the repository executor's `gh`
login. The saved GitHub host and owner/name identify every detail read and post;
a checkout retargeted to another repository or host is rejected. Before creating
a comment it re-reads the pull request after checkout and account preflight and checks that
the saved review is still current: a closed pull request or a
moved head posts nothing and marks the review outdated. The comment ends with a
hidden marker naming the repository, pull request, and commit. A marker for the
same commit already on the pull request counts as posted, so a post whose reply
was lost is never sent twice; an unconfirmed post is reported as unknown and
resolves the same way on the next attempt, even after a push or closure. Earlier
Garcon comments on the pull request are minimized as outdated. A failed
minimization exposes Retry cleanup, which never creates another comment.
Recent reviews keeps unresolved posts and cleanup failures ahead of newer runs.
Show all unresolved posts opens a paginated recovery list, including closed pull
requests beyond the recent-run limit. Its Reconcile post and Retry cleanup
actions remain available after closure and show their outcome on that review row. An unreadable
comment-creation reply also leaves the outcome unknown until marker recovery.
A transport failure, timeout, or unusable reply after mutation dispatch leaves
the outcome unknown. A proven preflight failure or explicit HTTP rejection
records a failed post, which does not lock the connection. A failed recovery
read cannot clear an earlier unknown outcome.
When recovery is impossible, **Abandon unresolved post** asks for confirmation:
the comment may already exist on GitHub and abandonment does not delete it.
Confirmation records a terminal abandoned state, timestamp, and posting actor,
retains the review, and releases the connection lock. The abandoned review
cannot be posted again. Abandonment is refused while a post is in flight.
A review longer than a GitHub comment is
kept and reported as too long, never truncated. Reviews never approve or
request changes.

Markers use a normalized repository identity and accept full 40- or 64-character
commit hashes. A case-only repository rename refreshes the displayed name while
preserving comment recovery. Posts for one GitHub pull request cannot overlap,
including connections on different executors; other pull requests can post
independently. Disconnecting a
repository is refused while its posts are in flight or have an unknown outcome.
Its executor and folder also remain fixed during posting and until an unknown
posting outcome has been reconciled or explicitly abandoned.
The controller records the posting actor's stable GitHub identity before
dispatch and retains it through recovery, so changing `gh` accounts cannot
send a duplicate comment.

## State

`pull-request-reviews.sqlite` in the workspace directory holds connected
repositories, their last pull request list and scan status, and review runs
with their review text. Startup creates missing tables and indexes without
schema versions or migrations. The schema enforces unique normalized
executor/host/repository identities. Databases created from earlier revisions of
this unmerged feature must be recreated.
Running work is not durable: a run that was queued or
running when the controller stopped is marked interrupted when it starts again,
and the next scan decides afresh. Runs are dropped 30 days after a successful
scan first observes the pull request closed, once its chat has been archived
(or no chat exists). Unresolved posts and failed cleanup are retained until
reconciled or explicitly abandoned. Reopening resets that retention period. Failed archival
is retried on later successful scans. A scan that overlaps a change to a
review run is discarded and repeated before it can invalidate that review.
A permission request in a review chat shows the run as Needs you; one
left unanswered for 30 minutes stops the review as failed.
Overlapping requests retain separate deadlines; answering one never shortens
another request's remaining time.

Inbox snapshots read only the newest run for each open pull request and a
bounded recent-run list. Selection reads indexed active/current-head summaries
and the last 24 hours' automatic-review count. A process-local per-repository
run revision fences pending scans without loading their history. A durable
per-pull revision invalidates only the selected pull request history; unrelated
scans do not reload it. Closure is
recorded once per pull request, so a repeated scan does not rewrite every run.
Archival and expired-history deletion use bounded batches separated by event
loop turns; unsuccessful archival remains eligible on a later successful scan.

A failed Stop outcome is reported even when its command resolves normally.
After a permission timeout, delivery failures remain visible and Stop is
retried every 30 seconds with a fresh command identity until the turn ends.
Timed-out reviews cannot publish a subsequently completed response.

The saved executor and provider selections join the executor and provider
reference guards, as scheduled prompts do.

Saved settings can be edited while the executor is offline, including turning
off automatic reviews or automatic posting. The saved review target stays fixed
until the executor is ready. An unchanged validated prompt does not require the
offline integration to be rediscovered. Failed scans keep the last saved list and show its
status in the inbox. Policy and posting reads paginate all GitHub connections; incomplete
reads fail instead of publishing a truncated successful scan.

The repository form's Filters and limits section configures base branches,
included and excluded labels, maximum changed lines (blank allows any size),
attempts per head commit, and daily starts. Branches and labels are entered
one per line. All supported limits can also be edited offline.

Review prompts can insert the saved repository URL with `{{repository_url}}`.
The built-in prompt uses that URL for commit-pinned code links, including
GitHub Enterprise hosts.

The Review tab loads history summaries in pages of 20 and fetches the review
text only for the selected run. It keeps the inbox's run summary while history
loads and shows history or body read failures with Retry. Review and Post remain
disabled until the required reads succeed. Changes to that pull request refresh
its history, including an older selected run after a posting result changes.

## Safety

A pull request is untrusted input to an agent Garcon does not sandbox. By
default, automatic review skips drafts and authors who are not owners,
members, or collaborators (the viewer always counts). Bots follow the same
author rules as other pull requests. Automatic review always excludes forks.
Allowing outside contributors shows a warning. A manual
Review is always allowed. The permission mode is the repository's choice and
starts from the new-chat default; which mode lets each agent run `gh` and
`git fetch` unattended is open decision 4 in the issue.

## Interfaces

- HTTP: `/api/v1/pull-request-reviews` (snapshot), `/repositories`
  (connect, edit, disconnect), `/scan`, `/runs` (20 summary rows with
  `nextCursor` and per-pull `revision`, or request a review), `/runs/detail`
  (one selected review body), `/runs/recovery` (20 unresolved-post summaries
  with `nextCursor`), `/runs/stop`, `/runs/post`, `/runs/abandon`
  (requires `{runId, confirm: true}`).
- WebSocket: `pull-request-reviews-invalidated` carries the store revision.
- Executor: three `ExecutionGhService` additions, described in the
  [Git contract](./executor/git.md).
- No CLI commands.

## Not Yet

Findings parsed from the review, inline GitHub review comments, a reaction for
clean reviews, reviewing in a worktree at the head commit, pull requests from
repositories that are not connected, addressing comments with an agent, and
GitHub Issues are later milestones of
the issue.
