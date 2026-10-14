# Pull Request Reviews

Garcon reviews pull requests in connected GitHub repositories with ordinary
chats and keeps each review's final response. Design discussion:
[cfal/garcon#897](https://github.com/cfal/garcon/issues/897). This page
describes what milestones 1 and 2 of that issue implement.

## Loop

1. **Connect.** A repository is an executor and a folder that is a checkout of
   a GitHub repository, plus the new-chat selection (agent, model, permission
   mode, effort, tags, preambles) its reviews start with. Connecting runs
   `gh` on that executor to resolve `owner/name` and the login it acts as. A
   folder that is not a checkout, or a repository already connected on the
   same executor, is refused.
2. **Scan.** Every 5 minutes, and at once after a connect, edit, or Scan now,
   the controller lists the repository's open pull requests through the
   executor's `gh`. An unreachable executor marks the repository paused and
   keeps its last list; it is never shown as having no pull requests.
3. **Select.** With automatic review on, a pull request is reviewed when it
   passes the repository's filters, has no finished or running review of its
   current head, has not used its attempts at that head, was not stopped by
   the user at that head, and its head has been unchanged for the debounce
   period, measured from when the scanner first saw it. The daily limit
   counts automatic reviews started in the last 24 hours.
4. **Start.** At most two reviews run at once, one per repository. A review is
   a new chat in the repository's folder, tagged `auto-review` and named
   `Review owner/name#N`, started with the repository's prompt.
5. **Collect.** When the turn ends, its final response is stored as the
   review. The review must contain exactly one `Reviewed commit: <sha>` line;
   without one the run fails and keeps the text. A review whose commit is no
   longer the head is outdated.
6. **Post.** Off keeps reviews in Garcon. Draft waits for Post to GitHub.
   Comment posts automatically.

Review chats are ordinary chats. Stopping one stops its review; deleting one
ends it. When a pull request leaves the open list, its review chats are
archived.

## Posting

The controller posts, never the agent, through the repository executor's `gh`
login. Before posting it re-reads the pull request: a closed pull request or a
moved head posts nothing and marks the review outdated. The comment ends with a
hidden marker naming the repository, pull request, and commit. A marker for the
same commit already on the pull request counts as posted, so a post whose reply
was lost is never sent twice; an unconfirmed post is reported as unknown and
resolves the same way on the next attempt. Earlier Garcon comments on the pull
request are minimized as outdated. A review longer than a GitHub comment is
kept and reported as too long, never truncated. Reviews never approve or
request changes.

## State

`pull-request-reviews.sqlite` in the workspace directory holds connected
repositories, their last pull request list and scan status, and review runs
with their review text. Schema version 2 adds normalized executor/repository
identities with a unique index; existing version 1 databases migrate on startup.
Running work is not durable: a run that was queued or
running when the controller stopped is marked interrupted when it starts again,
and the next scan decides afresh. Runs of pull requests closed for 30 days are
dropped. A permission request in a review chat shows the run as Needs you; one
left unanswered for 30 minutes stops the review as failed.

The saved executor and provider selections join the executor and provider
reference guards, as scheduled prompts do.

Saved settings can be edited while the executor is offline, including turning
off automatic reviews or posting. The saved review target stays fixed until the
executor is ready. Failed scans keep the last saved list and show its status in
the inbox. Policy and posting reads paginate all GitHub connections; incomplete
reads fail instead of publishing a truncated successful scan.

## Safety

A pull request is untrusted input to an agent Garcon does not sandbox. By
default, automatic review skips drafts, bots, authors who are not owners,
members, or collaborators (the viewer always counts), and pull requests from
forks. Widening either author filter shows a warning. A manual
Review is always allowed. The permission mode is the repository's choice and
starts from the new-chat default; which mode lets each agent run `gh` and
`git fetch` unattended is open decision 4 in the issue.

## Interfaces

- HTTP: `/api/v1/pull-request-reviews` (snapshot), `/repositories`
  (connect, edit, disconnect), `/scan`, `/runs` (list a pull request's runs
  with review text, or request a review), `/runs/stop`, `/runs/post`.
- WebSocket: `pull-request-reviews-invalidated` carries the store revision.
- Executor: three `ExecutionGhService` additions, described in the
  [Git contract](./executor/git.md).
- No CLI commands.

## Not Yet

Findings parsed from the review, inline GitHub review comments, a reaction for
clean reviews, reviewing in a worktree at the head commit, pull requests from
repositories that are not connected, and GitHub Issues are later milestones of
the issue.
