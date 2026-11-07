import type { GhPublishedPullRequest, GhRequests, GhRepositoryIdentity, GhActorIdentity } from '../../../common/gh.js';
import { ghRepositoryFromRemote, isGhActorIdentity, sameGhRepository, matchesPublication } from '../../../common/gh-identity.js';
import { isGitObjectId } from '../../../common/git-managed-worktrees.js';
import { isRecord } from '../../../common/json.js';
import { GitServiceError } from '../../../common/git-error.js';
import { requireExactRemoteUrl } from '../git/delivery.js';
import { readOnlyGitOptions } from '../git/run.js';
import { runExactGit } from '../git/exact-objects.js';
import { assertGhActor, readPostingActor, resolveCheckoutRepository } from './gh-repository.js';
import { runGhJson, runGhMutation, parseGhJson } from './run.js';

function reject(detail: string): never { throw new GitServiceError('GH_MUTATION_REJECTED', detail); }

async function branch(projectPath: string, repository: GhRepositoryIdentity, name: string, signal?: AbortSignal): Promise<string> {
  await runExactGit(projectPath, ['check-ref-format', `refs/heads/${name}`], readOnlyGitOptions());
  const result = await runGhJson<{ object?: { sha?: string } }>(projectPath,
    ['api', '--hostname', repository.host, `repos/${repository.nameWithOwner}/git/ref/heads/${encodeURIComponent(name)}`], { signal });
  if (!isGitObjectId(result.object?.sha)) reject('GitHub did not return an exact branch head.');
  return result.object!.sha!;
}

export async function getPublicationTarget(input: GhRequests['getPublicationTarget'] & { signal?: AbortSignal }) {
  const url = await requireExactRemoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'push');
  const repository = ghRepositoryFromRemote(url);
  if (!repository) reject('Publication requires an explicit GitHub SSH or HTTPS repository URL.');
  await resolveCheckoutRepository(input.projectPath, repository, input.signal);
  const actor = await readPostingActor(input.projectPath, repository, input.signal);
  const baseCommit = await branch(input.projectPath, repository, input.baseBranch, input.signal);
  return { repository, actor, baseCommit };
}

export function parsePublishedPullRequest(value: unknown, repository: GhRepositoryIdentity): GhPublishedPullRequest {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base) || !isRecord(value.user)
    || !Number.isSafeInteger(value.number) || Number(value.number) <= 0 || typeof value.title !== 'string'
    || value.title.length > 256 || typeof value.body !== 'string' || value.body.length > 65536
    || typeof value.draft !== 'boolean' || !['open', 'closed'].includes(String(value.state))
    || typeof value.head.ref !== 'string' || typeof value.base.ref !== 'string'
    || !isGitObjectId(value.head.sha) || !isGitObjectId(value.base.sha)
    || !isRecord(value.head.repo) || !isRecord(value.base.repo)
    || typeof value.head.repo.full_name !== 'string' || typeof value.base.repo.full_name !== 'string'
    || value.head.repo.full_name.toLowerCase() !== repository.nameWithOwner.toLowerCase()
    || value.base.repo.full_name.toLowerCase() !== repository.nameWithOwner.toLowerCase()) {
    throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an invalid publication record.');
  }
  const actor = { id: value.user.node_id, login: value.user.login };
  if (!isGhActorIdentity(actor)) throw new GitServiceError('GIT_INVALID_RESULT', 'Publication author is unavailable.');
  const expectedUrl = `https://${repository.host}/${repository.nameWithOwner}/pull/${value.number}`;
  if (typeof value.html_url !== 'string' || value.html_url.toLowerCase() !== expectedUrl.toLowerCase())
    throw new GitServiceError('GIT_INVALID_RESULT', 'Publication URL does not match its repository.');
  return { repository, actor, number: Number(value.number), url: value.html_url,
    state: value.merged_at ? 'merged' : value.state as 'open' | 'closed', title: value.title, body: value.body,
    draft: value.draft, headBranch: value.head.ref, baseBranch: value.base.ref, headCommit: value.head.sha, baseCommit: value.base.sha };
}

export async function createPullRequest(input: GhRequests['createPullRequest'] & { signal?: AbortSignal }): Promise<GhPublishedPullRequest> {
  try {
    if (!input.body.includes(input.marker)) reject('Publication body must contain its approved marker.');
    const target = await getPublicationTarget(input);
    if (!sameGhRepository(target.repository, input.repository)) reject('Publication repository changed.');
    assertGhActor(target.actor, input.actor);
    if (target.baseCommit !== input.baseCommit || await branch(input.projectPath, input.repository, input.headBranch, input.signal) !== input.headCommit)
      reject('Publication branch head changed.');
    input.signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof GitServiceError && error.code === 'GH_MUTATION_REJECTED') throw error;
    reject(error instanceof Error ? error.message : 'Publication preflight failed.');
  }
  const reply = await runGhMutation(input.projectPath,
    ['api', '--hostname', input.repository.host, '--method', 'POST', `repos/${input.repository.nameWithOwner}/pulls`, '--input', '-'],
    { signal: input.signal, stdin: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: input.baseBranch, draft: input.draft }),
      maxStdoutBytes: 256 * 1024 });
  try {
    const result = parsePublishedPullRequest(parseGhJson(reply.stdout, 'api'), input.repository);
    if (!matchesPublication(result, input)) throw new Error('Publication identity changed.');
    return result;
  } catch { throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'GitHub did not confirm the exact approved publication.'); }
}

export async function findPullRequests(input: GhRequests['findPullRequests'] & { signal?: AbortSignal }) {
  await resolveCheckoutRepository(input.projectPath, input.repository, input.signal);
  const actor: GhActorIdentity = await readPostingActor(input.projectPath, input.repository, input.signal);
  assertGhActor(actor, input.actor);
  const owner = input.repository.nameWithOwner.split('/')[0]!;
  const query = new URLSearchParams({ state: 'all', head: `${owner}:${input.headBranch}`, base: input.baseBranch, per_page: '100' });
  const raw = await runGhJson<unknown>(input.projectPath,
    ['api', '--hostname', input.repository.host, `repos/${input.repository.nameWithOwner}/pulls?${query}`], { signal: input.signal, maxStdoutBytes: 4 * 1024 * 1024 });
  if (!Array.isArray(raw) || raw.length >= 100) throw new GitServiceError('GIT_RESULT_TOO_LARGE', 'Publication lookup was incomplete.');
  const pulls = raw.filter(value => isRecord(value) && typeof value.body === 'string' && value.body.includes(input.marker))
    .map(value => parsePublishedPullRequest(value, input.repository));
  return { repository: input.repository, actor, pulls };
}
