// Conditional REST reads through `gh api`. Each page is sent with the ETag of
// its last response; an unchanged page comes back as 304 Not Modified and its
// cached body is reused. GitHub does not count a 304 against the primary rate
// limit when the request is authorized, but it is still one request:
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate
//
// `gh api --include` prints the status line, the headers, and a blank line
// before the body, and exits 1 for every status above 299, 304 included,
// after printing them (cli/cli v2.97.0, `processResponse`):
// https://github.com/cli/cli/blob/55dbb4dc6b7edb10b48e3d7fc5bccd32318d1b55/pkg/cmd/api/api.go#L473-L561

import { createHash } from 'node:crypto';
import type { GhRepositoryIdentity } from '../../../common/gh.js';
import { GitServiceError } from '../../../common/git-error.js';
import { classifyGhError } from './gh-error-classifier.js';
import type { GhResponseCache, GhResponseKey } from './gh-response-cache.js';
import type { GhProcessError } from './gh-types.js';
import { runGh } from './run.js';

const PER_PAGE = 100;
const MAX_PAGES = 100;
// Statuses after which the account must not see a cached body for the repository.
const REFUSED = new Set([401, 403, 404, 410, 451]);

interface IncludedResponse {
  status: number;
  etag: string | null;
  hasNextPage: boolean;
  body: string;
}

export function parseIncludedResponse(stdout: string): IncludedResponse | null {
  const statusEnd = stdout.indexOf('\n');
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(stdout.slice(0, statusEnd))?.[1];
  if (statusEnd < 0 || !status) return null;
  let offset = statusEnd + 1;
  const headers = new Map<string, string>();
  for (;;) {
    const lineEnd = stdout.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const line = stdout.slice(offset, lineEnd);
    offset = lineEnd + 2;
    if (line === '') break;
    const separator = line.indexOf(':');
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return {
    status: Number(status),
    etag: headers.get('etag') || null,
    hasNextPage: /<[^>]*>;\s*rel="next"/.test(headers.get('link') ?? ''),
    body: stdout.slice(offset),
  };
}

// Digest of the token `gh` would send to `host`; reading it makes no request.
// Without one the read is unconditional and nothing is cached.
async function credentialScope(cwd: string, host: string, signal?: AbortSignal): Promise<{ account: string; token: string } | null> {
  try {
    const { stdout } = await runGh(cwd, ['auth', 'token', '--hostname', host], { signal, maxStdoutBytes: 64 * 1024 });
    const token = stdout.trim();
    return token ? { account: createHash('sha256').update(`${host.toLowerCase()}\0${token}`).digest('hex'), token } : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

type PageOutcome =
  | { kind: 'response'; response: IncludedResponse }
  // GitHub refused the account; `error` keeps gh's message for classification.
  | { kind: 'refused'; error: unknown };

async function requestPage(cwd: string, host: string, path: string, etag: string | undefined, token: string | undefined, signal?: AbortSignal): Promise<PageOutcome> {
  const args = ['api', '--hostname', host, '--include', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), path];
  let stdout: string;
  try {
    stdout = (await runGh(cwd, args, { signal, ...(token ? { env: { GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token } } : {}) })).stdout;
  } catch (error) {
    const processError = error as GhProcessError;
    if (processError.timedOut || processError.aborted || typeof processError.stdout !== 'string') throw error;
    const response = parseIncludedResponse(processError.stdout);
    if (response?.status === 304) return { kind: 'response', response };
    // A rate limit is also a 403, but it says nothing about access and validators are what save quota.
    if (response && REFUSED.has(response.status) && classifyGhError(error).code !== 'RATE_LIMITED') return { kind: 'refused', error };
    throw error;
  }
  const response = parseIncludedResponse(stdout);
  if (!response) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an unreadable response.');
  return { kind: 'response', response };
}

// Reads every page of a REST listing, reusing each unchanged page's body.
export async function readConditionalPages(
  cwd: string,
  repository: GhRepositoryIdentity,
  path: string,
  cache: GhResponseCache,
  signal?: AbortSignal,
): Promise<unknown[][]> {
  const credential = await credentialScope(cwd, repository.host, signal);
  const pages: unknown[][] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new GitServiceError('GIT_RESULT_TOO_LARGE', `GitHub listing exceeds ${MAX_PAGES} pages.`);
    const pagePath = `${path}?per_page=${PER_PAGE}&page=${page}`;
    const key: GhResponseKey | null = credential ? { account: credential.account, repository, path: pagePath } : null;
    const cached = key ? cache.get(key) : undefined;
    const outcome = await requestPage(cwd, repository.host, pagePath, cached?.etag, credential?.token, signal);
    if (outcome.kind === 'refused') {
      cache.forgetRepository(repository);
      throw outcome.error;
    }
    const { response } = outcome;
    const notModified = response.status === 304;
    // A 304 to a request that sent no validator would leave nothing to reuse.
    if (notModified && !cached) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub reported an unchanged page that was never read.');
    const body = notModified ? cached!.body : response.body;
    let items: unknown;
    try { items = JSON.parse(body); }
    catch { throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an unreadable listing page.'); }
    if (!Array.isArray(items)) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned an unreadable listing page.');
    let hasNextPage = notModified ? cached!.hasNextPage : response.hasNextPage;
    if (key && !notModified) {
      if (response.etag) cache.set(key, { etag: response.etag, body, hasNextPage });
      else cache.delete(key);
    }
    // A 304 may not repeat the Link header, and an unchanged full last page
    // says nothing about items added after it, so the next page is probed.
    if (notModified && !hasNextPage && items.length >= PER_PAGE) hasNextPage = true;
    pages.push(items);
    if (!hasNextPage) return pages;
  }
}
