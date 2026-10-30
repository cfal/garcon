// Reads the fingerprints of every open pull request in up to
// `GH_FINGERPRINT_BATCH_SIZE` repositories with one aliased GraphQL query.
// GitHub answers a query whose repositories partly fail with the data it could
// read and an `errors` entry whose path names each failed alias, so failures
// map to their repositories. A query that fails as a whole throws: no
// repository of a failed batch can look unchanged.

import type { GhRepositoryIdentity, PullRequestFingerprintBatch, RepositoryPullRequestFingerprints } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import { GitServiceError } from '../../../common/git-error.js';
import { mapFingerprint, type GhRawFingerprintPullRequest, type GhRawNodes } from './gh-mappers.js';
import { requireGhActor } from './gh-repository.js';
import { fingerprintQuery } from './gh-review-queries.js';
import type { GhProcessError } from './gh-types.js';
import { runGh } from './run.js';

const MESSAGE_MAX_LENGTH = 512;

interface GraphqlError {
  type?: string;
  message?: string;
  path?: unknown[];
}

interface RawRepository {
  nameWithOwner?: string;
  url?: string;
  pullRequests?: (Omit<GhRawNodes<GhRawFingerprintPullRequest>, 'pageInfo'> & { pageInfo?: { hasNextPage?: boolean } | null }) | null;
}

interface RawBatch {
  data?: Record<string, unknown> | null;
  errors?: GraphqlError[];
}

function parseBatch(stdout: string): RawBatch | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as RawBatch : null;
  } catch {
    return null;
  }
}

// `gh api graphql` prints a response that carries errors and exits 1
// (cli/cli v2.97.0, `processResponse`), so the body of a partial answer is on
// the failed process's stdout.
async function runBatch(cwd: string, args: string[], signal?: AbortSignal): Promise<RawBatch> {
  let stdout: string;
  try {
    stdout = (await runGh(cwd, args, { signal })).stdout;
  } catch (error) {
    const processError = error as GhProcessError;
    if (processError.timedOut || processError.aborted || typeof processError.stdout !== 'string') throw error;
    const partial = parseBatch(processError.stdout);
    if (!partial?.data || !Array.isArray(partial.errors) || partial.errors.length === 0) throw error;
    // Only errors confined to aliased repositories leave the rest of the answer usable.
    if (!partial.errors.every((entry) => Array.isArray(entry.path) && /^r\d+$/.test(String(entry.path[0])))) throw error;
    return partial;
  }
  const batch = parseBatch(stdout);
  if (!batch?.data) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an unreadable fingerprint batch.');
  return batch;
}

function failure(error: GraphqlError | undefined): RepositoryPullRequestFingerprints {
  const reason = error?.type === 'NOT_FOUND' ? 'not-found' : error?.type === 'FORBIDDEN' ? 'forbidden' : 'error';
  const message = (error?.message || 'GitHub returned no repository.').slice(0, MESSAGE_MAX_LENGTH);
  return { kind: 'failed', reason, message };
}

export function mapRepositoryFingerprints(expected: GhRepositoryIdentity, raw: unknown, errors: GraphqlError[]): RepositoryPullRequestFingerprints {
  if (errors.length > 0 || raw === null || typeof raw !== 'object') return failure(errors[0]);
  const repository = raw as RawRepository;
  const repo = { nameWithOwner: repository.nameWithOwner ?? '', url: repository.url ?? '' };
  const identity = ghRepositoryIdentity(repo);
  if (!identity || !sameGhRepository(identity, expected)) {
    return { kind: 'failed', reason: 'error', message: 'GitHub answered for a different repository.' };
  }
  const connection = repository.pullRequests;
  const hasNextPage = connection?.pageInfo?.hasNextPage;
  if (hasNextPage === true) return { kind: 'incomplete' };
  if (hasNextPage !== false || !Array.isArray(connection?.nodes)) {
    return { kind: 'failed', reason: 'error', message: 'GitHub returned an incomplete pull request connection.' };
  }
  const pulls = connection.nodes.filter((node): node is GhRawFingerprintPullRequest => node !== null && typeof node?.number === 'number');
  return { kind: 'read', repo, pulls: pulls.map(mapFingerprint) };
}

export async function readPullRequestFingerprints(
  cwd: string,
  repositories: readonly GhRepositoryIdentity[],
  signal?: AbortSignal,
): Promise<PullRequestFingerprintBatch> {
  const variables = repositories.flatMap((repository, index) => {
    const [owner, name] = repository.nameWithOwner.split('/');
    return ['-f', `o${index}=${owner}`, '-f', `n${index}=${name}`];
  });
  const raw = await runBatch(cwd, [
    'api', 'graphql', '--hostname', repositories[0].host, ...variables, '-f', `query=${fingerprintQuery(repositories.length)}`,
  ], signal);
  const viewer = requireGhActor(raw.data?.viewer);
  const errors = raw.errors ?? [];
  return {
    viewerLogin: viewer.login,
    repositories: repositories.map((repository, index) => {
      const alias = `r${index}`;
      return mapRepositoryFingerprints(repository, raw.data?.[alias], errors.filter((entry) => Array.isArray(entry.path) && entry.path[0] === alias));
    }),
  };
}
