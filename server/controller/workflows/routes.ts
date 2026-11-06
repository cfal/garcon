import { WORKFLOW_API, WORKFLOW_MUTATION_PATHS, parseWorkflowHttpMutation, workflowQuery, workflowQueryId, workflowQueryInteger } from '../../../common/workflow-http.js';
import type { WorkflowMutation } from '../../../common/workflows.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import { markRouteNoStore } from '../lib/http-route.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { validateWorkflowInput } from './errors.js';
import { readWorkflowBody, workflowAuthority, workflowJson } from './http.js';
import type { WorkflowService } from './service.js';
import type { WorkflowSettings } from './settings.js';
import { workflowBoolean, workflowRecord, workflowId } from '../../../common/workflow-validation.js';

export function createWorkflowRoutes(runtime: { readonly service: WorkflowService; openRecovery?: () => Promise<void> }, settings?: WorkflowSettings): RouteMap {
  const guarded = (handler: RouteHandler): RouteHandler => markRouteNoStore(async (request, url, server, context) => {
    try {
      workflowAuthority(context);
      request.signal.throwIfAborted();
      if (url.pathname !== `${WORKFLOW_API}/enabled`) await runtime.openRecovery?.();
      workflowAuthority(context);
      const response = await handler(request, url, server, context);
      workflowAuthority(context);
      return response;
    } catch (error) {
      const response = jsonErrorFromUnknown(error);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  });
  const read = (path: string, keys: readonly string[], operation: (query: URLSearchParams) => unknown): RouteMap => ({
    [`${WORKFLOW_API}${path}`]: { GET: guarded((_request, url) => workflowJson(validateWorkflowInput(() => operation(workflowQuery(url, keys))))) },
  });
  const routes: RouteMap = {
    ...read('/bootstrap', [], () => runtime.service.bootstrap()),
    ...read('', ['after', 'limit'], query => runtime.service.list(query.get('after'), workflowQueryInteger(query, 'limit', 50))),
    ...read('/detail', ['id'], query => runtime.service.overview(workflowQueryId(query))),
    ...read('/plan', ['id', 'planRevision'], query => runtime.service.plan(workflowQueryId(query), workflowQueryInteger(query, 'planRevision'))),
    ...read('/gate', ['id', 'gateId'], query => runtime.service.inspectGate(workflowQueryId(query), workflowId(query.get('gateId')))),
    ...read('/attempt', ['id', 'attemptId'], query => runtime.service.inspectAttempt(workflowQueryId(query), workflowId(query.get('attemptId')))),
    ...read('/diagram', ['id', 'planRevision'], query => ({ mermaid: runtime.service.diagram(workflowQueryId(query), workflowQueryInteger(query, 'planRevision')) })),
    ...read('/attempts', ['id', 'before', 'limit'], query => ({ attempts: runtime.service.attempts(workflowQueryId(query), query.get('before'), workflowQueryInteger(query, 'limit', 50)) })),
    ...read('/activity', ['id', 'before', 'limit'], query => ({ activity: runtime.service.activity(workflowQueryId(query), workflowQueryInteger(query, 'before', Number.MAX_SAFE_INTEGER), workflowQueryInteger(query, 'limit', 50)) })),
    ...read('/artifacts', ['id', 'after', 'limit'], query => ({ artifacts: runtime.service.artifacts(workflowQueryId(query), query.get('after'), workflowQueryInteger(query, 'limit', 50)) })),
    [`${WORKFLOW_API}/operation`]: { GET: guarded((_request, url, _server, context) => workflowJson(
      validateWorkflowInput(() => runtime.service.operation(workflowQueryId(workflowQuery(url, ['id'])), workflowAuthority(context))),
    )) },
  };
  for (const action of Object.keys(WORKFLOW_MUTATION_PATHS) as WorkflowMutation['action'][]) {
    const path = WORKFLOW_MUTATION_PATHS[action];
    routes[path] = { ...routes[path], POST: guarded(async (request, url, _server, context) => {
      validateWorkflowInput(() => workflowQuery(url, []));
      const raw = await readWorkflowBody(request);
      const mutation = validateWorkflowInput(() => parseWorkflowHttpMutation(raw, action));
      request.signal.throwIfAborted();
      return workflowJson(await runtime.service.executeHttp(mutation, workflowAuthority(context), request.signal), action === 'create' ? 201 : 200);
    }) };
  }
  if (settings) routes[`${WORKFLOW_API}/enabled`] = { PUT: guarded(async (request, url, _server, context) => {
    validateWorkflowInput(() => workflowQuery(url, []));
    const body = await readWorkflowBody(request);
    const enabled = validateWorkflowInput(() => workflowBoolean(workflowRecord(body, ['enabled']).enabled));
    const authority = workflowAuthority(context);
    await settings.setEnabled(enabled, authority.assertCurrent);
    return workflowJson({ enabled });
  }) };
  return routes;
}
