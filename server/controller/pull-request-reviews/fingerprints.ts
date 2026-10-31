// Decides what a fingerprint read of a repository's open pull requests
// requires. The scanner's full read lists every open pull request with its
// labels, review requests, and team review-request search: three or more `gh`
// calls per repository. A fingerprint batch covers up to
// `GH_FINGERPRINT_BATCH_SIZE` repositories of one executor and host with one.
//
// - Unchanged fingerprints keep the saved list; nothing else is read.
// - Checks, mergeability, and the review decision change without moving
//   `updatedAt`, and the fingerprint carries their new values, so they are
//   applied to the saved summaries without a full read.
// - Anything else (a new, closed, or reopened pull request, a push, a base
//   change, new reviews, an edit that moves `updatedAt`, another account, or a
//   renamed repository) needs the full read, because the summary fields it
//   would change are not in the fingerprint.
// - A repository the batch could not read, or with more open pull requests
//   than one page, is read in full, so its error or list is the full read's.
//
// Browsers then refresh the selected pull request's status, review threads, or
// diff from the summary fields each depends on; see
// `web/src/lib/git/pull-requests/pull-request-refresh-keys.ts`.

import {
  GH_FINGERPRINT_BATCH_SIZE,
  type GhRepositoryIdentity,
  type PullRequestFingerprint,
  type PullRequestSummary,
  type RepositoryPullRequestFingerprints,
} from '../../../common/gh.js';

type FingerprintField = keyof PullRequestFingerprint;
// What a change to each fingerprint field requires; a new field must choose.
const FIELD_CHANGES = {
  number: 'key', updatedAt: 'full-read', isDraft: 'full-read', headRefOid: 'full-read', baseRefOid: 'full-read',
  reviewCount: 'full-read', reviewThreadCount: 'full-read',
  checksState: 'apply', reviewDecision: 'apply', mergeable: 'apply',
} as const satisfies Record<FingerprintField, 'key' | 'full-read' | 'apply'>;
const fieldsRequiring = (change: 'full-read' | 'apply') =>
  (Object.keys(FIELD_CHANGES) as FingerprintField[]).filter((field) => FIELD_CHANGES[field] === change);
const FULL_READ_FIELDS = fieldsRequiring('full-read');
const APPLIED_FIELDS = fieldsRequiring('apply');

export interface FingerprintedRepository {
  readonly pulls: readonly PullRequestSummary[];
  readonly viewerLogin: string | null;
  readonly nameWithOwner: string;
  readonly url: string;
}

export type FingerprintPlan =
  | { kind: 'unchanged' }
  | { kind: 'apply'; pulls: PullRequestSummary[] }
  | { kind: 'full-read' };

export function planFingerprintRefresh(
  saved: FingerprintedRepository,
  viewerLogin: string,
  fingerprints: RepositoryPullRequestFingerprints,
): FingerprintPlan {
  if (fingerprints.kind !== 'read' || viewerLogin !== saved.viewerLogin
    || fingerprints.repo.nameWithOwner !== saved.nameWithOwner || fingerprints.repo.url !== saved.url
    || fingerprints.pulls.length !== saved.pulls.length) return { kind: 'full-read' };
  const current = new Map(fingerprints.pulls.map((pull) => [pull.number, pull]));
  let changed = false;
  const pulls: PullRequestSummary[] = [];
  for (const pull of saved.pulls) {
    const fingerprint = current.get(pull.number);
    if (!fingerprint || FULL_READ_FIELDS.some((field) => pull[field] !== fingerprint[field])) return { kind: 'full-read' };
    if (APPLIED_FIELDS.every((field) => pull[field] === fingerprint[field])) {
      pulls.push(pull);
      continue;
    }
    changed = true;
    pulls.push({ ...pull, ...Object.fromEntries(APPLIED_FIELDS.map((field) => [field, fingerprint[field]])) });
  }
  return changed ? { kind: 'apply', pulls } : { kind: 'unchanged' };
}

export interface FingerprintCandidate {
  readonly executorId: string;
  readonly identity: GhRepositoryIdentity;
}

// Groups candidates by executor and host, in order, into batches one query answers.
export function fingerprintBatches<T extends FingerprintCandidate>(candidates: readonly T[], size = GH_FINGERPRINT_BATCH_SIZE): T[][] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.executorId, candidate.identity.host.toLowerCase()]);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const batches: T[][] = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += size) batches.push(group.slice(start, start + size));
  }
  return batches;
}
