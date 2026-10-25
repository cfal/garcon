import type { GhActorIdentity, GhRepositoryIdentity } from '../../../common/gh.js';
import { ghRepositoryIdentity, isGhActorIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import { GitServiceError } from '../../../common/git-error.js';
import { runGhJson } from './run.js';

export async function resolveCheckoutRepository(projectPath: string, expected?: GhRepositoryIdentity, signal?: AbortSignal): Promise<GhRepositoryIdentity> {
  const raw = await runGhJson<{ nameWithOwner: string; url: string }>(projectPath, ['repo', 'view', '--json', 'nameWithOwner,url'], { signal });
  const identity = ghRepositoryIdentity(raw);
  if (!identity) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an invalid repository identity.');
  if (expected && !sameGhRepository(identity, expected)) {
    throw new GitServiceError('GIT_CONFLICT', 'The checkout repository has changed. Reconnect the intended repository before continuing.');
  }
  return identity;
}

export function repositoryFields(repository: GhRepositoryIdentity): string[] {
  const [owner, name] = repository.nameWithOwner.split('/');
  return ['-f', `owner=${owner}`, '-f', `name=${name}`];
}

export function requireGhActor(value: unknown): GhActorIdentity {
  if (!isGhActorIdentity(value)) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an invalid account identity.');
  return value;
}

export function assertGhActor(actual: GhActorIdentity, expected: GhActorIdentity): void {
  if (actual.id !== expected.id) throw new GitServiceError('GIT_CONFLICT', `The GitHub account has changed. Switch back to ${expected.login} before continuing.`);
}

export async function readPostingActor(projectPath: string, repository: GhRepositoryIdentity, signal?: AbortSignal): Promise<GhActorIdentity> {
  const raw = await runGhJson<{ data?: { viewer?: GhActorIdentity } }>(projectPath,
    ['api', 'graphql', '--hostname', repository.host, '-f', 'query=query{viewer{id login}}'], { signal });
  return requireGhActor(raw.data?.viewer);
}
