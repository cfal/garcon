import type { GhActorIdentity, GhRepositoryIdentity, GhPublishedPullRequest, GhPublicationRequest } from './gh.js';
import { isRecord } from './json.js';

const REPOSITORY_NAME = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export function isGhRepositoryIdentity(value: unknown): value is GhRepositoryIdentity {
  return isRecord(value) && typeof value.host === 'string' && value.host.length <= 253 && HOST.test(value.host)
    && typeof value.nameWithOwner === 'string' && value.nameWithOwner.length <= 140 && REPOSITORY_NAME.test(value.nameWithOwner)
    && Object.keys(value).every(key => key === 'host' || key === 'nameWithOwner');
}

export function isGhActorIdentity(value: unknown): value is GhActorIdentity {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 && !value.id.includes('\0')
    && typeof value.login === 'string' && value.login.length > 0 && value.login.length <= 256 && !value.login.includes('\0')
    && Object.keys(value).every(key => key === 'id' || key === 'login');
}

// Repository URLs bind persisted names to the GitHub host that owns them.
export function ghRepositoryIdentity(repository: { nameWithOwner: string; url: string }): GhRepositoryIdentity | null {
  try {
    const url = new URL(repository.url);
    const identity = { host: url.hostname.toLowerCase(), nameWithOwner: repository.nameWithOwner.toLowerCase() };
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname.replace(/\/$/, '').toLowerCase() !== `/${identity.nameWithOwner}` || !isGhRepositoryIdentity(identity)) return null;
    return identity;
  } catch {
    return null;
  }
}

export function sameGhRepository(left: GhRepositoryIdentity, right: GhRepositoryIdentity): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() && left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase();
}

export function ghRepositoryFromRemote(remote: string): GhRepositoryIdentity | null {
  try {
    const scp = /^git@([^:]+):([^\s]+)$/u.exec(remote);
    const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote);
    if (!['ssh:', 'https:'].includes(url.protocol) || url.password || url.port || url.search || url.hash
      || url.username && (url.protocol !== 'ssh:' || url.username !== 'git')) return null;
    const repository = { host: url.hostname.toLowerCase(), nameWithOwner: url.pathname.slice(1).replace(/\.git$/u, '').toLowerCase() };
    return isGhRepositoryIdentity(repository) ? repository : null;
  } catch { return null; }
}

export function matchesPublication(actual: GhPublishedPullRequest, expected: Pick<GhPublicationRequest,
  'repository' | 'actor' | 'baseBranch' | 'baseCommit' | 'headBranch' | 'headCommit' | 'title' | 'body' | 'draft'>): boolean {
  return sameGhRepository(actual.repository, expected.repository) && actual.actor.id === expected.actor.id
    && actual.state === 'open' && actual.baseBranch === expected.baseBranch && actual.baseCommit === expected.baseCommit
    && actual.headBranch === expected.headBranch && actual.headCommit === expected.headCommit
    && actual.title === expected.title && actual.body === expected.body && actual.draft === expected.draft;
}
