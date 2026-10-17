import type { GhActorIdentity, GhRepositoryIdentity } from './gh.js';
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
