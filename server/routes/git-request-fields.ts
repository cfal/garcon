import { GIT_MAX_REQUEST_BYTES } from '../../common/git-execution.js';
import { GIT_REQUEST_FIELDS } from '../../common/git-request-validation.js';
import { GitServiceError } from '../../common/git-error.js';
import { isGitRefKind } from '../../common/git-refs.js';
import { isRecord } from '../../common/json.js';
import type { GitMethod } from '../../common/git.js';
import type { RouteHandler } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { executionNodeIdFromValue } from './node-target.js';
import { gitRouteFailure } from './git-node-service.js';
import type { JsonBody } from './route-helpers.js';

export function validateGitHttpFields(method: GitMethod, input: unknown, extra: readonly string[] = []): void {
  const fields: readonly string[] = ['nodeId', 'project', ...GIT_REQUEST_FIELDS[method], ...extra,
    ...(method === 'checkout' ? ['branch'] : []), ...(method === 'getRefs' ? ['direction'] : [])];
  if (!isRecord(input) || Object.keys(input).some(key => !fields.includes(key))
    || Buffer.byteLength(JSON.stringify(input)) > GIT_MAX_REQUEST_BYTES) {
    throw new GitServiceError('GIT_INVALID_INPUT', `Invalid Git ${method} request fields`);
  }
  executionNodeIdFromValue(input.nodeId);
  for (const key of ['force', 'detach', 'includeUntracked']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new GitServiceError('GIT_INVALID_INPUT', `Invalid ${key}`);
  }
  if (input.refKind !== undefined && !isGitRefKind(input.refKind)) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid ref kind');
}

export function gitJsonBody(method: GitMethod, handler: (body: JsonBody, request: Request) => Promise<Response>): RouteHandler {
  return withJsonBody(async (body: JsonBody, request: Request) => {
    try { validateGitHttpFields(method, body); return await handler(body, request); }
    catch (error) { return gitRouteFailure(error); }
  });
}

export function gitQuery(method: GitMethod, handler: RouteHandler): RouteHandler {
  return async (request, url, server, context) => {
    try {
      for (const key of url.searchParams.keys()) {
        if (url.searchParams.getAll(key).length !== 1) throw new GitServiceError('GIT_INVALID_INPUT', `Duplicate ${key}`);
      }
      validateGitHttpFields(method, Object.fromEntries(url.searchParams));
      return await handler(request, url, server, context);
    } catch (error) { return gitRouteFailure(error); }
  };
}
