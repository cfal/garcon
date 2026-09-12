import { parseHttpIssueMutationRequest } from '../../common/issue-commands.js';
import { issueQueryParams } from '../../common/issue-query.js';
import { issueRecord, issueString } from '../../common/issue-validation.js';
import { deriveIssueCaller } from '../issues/contracts.js';
import { IssueDomainError, validateIssueInput } from '../issues/errors.js';
import { issueErrorResponse, issueJson, readIssueBody, requireIssuePrincipal } from '../issues/http.js';
import { resolveIssueProjectDefault } from '../issues/project-default.js';
import type { IssueRuntime } from '../issues/setup.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { markRouteNoStore } from '../lib/http-route.js';

function authenticated(handler: RouteHandler): RouteHandler {
  return markRouteNoStore(async (request, url, server, context) => {
    try {
      requireIssuePrincipal(context);
      request.signal.throwIfAborted();
      return await handler(request, url, server, context);
    } catch (error) {
      return issueErrorResponse(error);
    }
  });
}

export function createIssueRoutes(issues: IssueRuntime,
  projectDefault = resolveIssueProjectDefault): RouteMap {
  const query = (url: URL) => validateIssueInput(() => issueQueryParams(url.searchParams));
  return {
    '/api/v1/issues/bootstrap': { GET: authenticated((_request, url, _server, context) => {
      validateIssueInput(() => issueRecord(query(url), []));
      return issueJson(issues.service.bootstrap(deriveIssueCaller(requireIssuePrincipal(context)).authority));
    }) },
    '/api/v1/issues': { GET: authenticated((_request, url) => issueJson(issues.service.list(query(url)))) },
    '/api/v1/issues/counts': { GET: authenticated((_request, url) => issueJson(issues.service.counts(query(url)))) },
    '/api/v1/issues/detail': { GET: authenticated((_request, url, _server, context) =>
      issueJson(issues.service.read(query(url), deriveIssueCaller(requireIssuePrincipal(context)).authority))) },
    '/api/v1/issues/comments': { GET: authenticated((_request, url, _server, context) =>
      issueJson(issues.service.comments(query(url), deriveIssueCaller(requireIssuePrincipal(context)).authority))) },
    '/api/v1/issues/history': { GET: authenticated((_request, url) => issueJson(issues.service.history(query(url)))) },
    '/api/v1/issues/facets': { GET: authenticated((_request, url) => {
      const raw = validateIssueInput(() => issueRecord(query(url), ['field', 'prefix']));
      if (raw.field !== 'project' && raw.field !== 'label') {
        throw new IssueDomainError('ISSUE_VALIDATION_FAILED', 'Facet field must be project or label.');
      }
      const prefix = validateIssueInput(() => issueString(raw.prefix ?? '', 'prefix'));
      return issueJson(issues.service.facets(raw.field, prefix));
    }) },
    '/api/v1/issues/project-default': { POST: authenticated(async (request) => {
      const raw = await readIssueBody(request);
      const directory = validateIssueInput(() => issueString(issueRecord(raw, ['directory']).directory, 'directory'));
      return issueJson(await projectDefault(directory, request.signal));
    }) },
    '/api/v1/issues/mutate': { POST: authenticated(async (request, _url, _server, context) => {
      const raw = await readIssueBody(request);
      const envelope = validateIssueInput(() => parseHttpIssueMutationRequest(raw));
      const caller = deriveIssueCaller(requireIssuePrincipal(context), envelope.fromChatId);
      const result = issues.service.executeHttp(envelope, caller, request.signal);
      return issueJson(result, envelope.payload.action === 'create' ? 201 : 200);
    }) },
  };
}
