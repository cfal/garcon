import { parseWorkflowDefinition, parseWorkflowStepAddition, type WorkflowDefinition, type WorkflowDiagnostic, type WorkflowStep } from '../../../common/workflow-definition.js';
import { workflowPaths } from '../../../common/workflow-http.js';
import type { WorkflowActor, WorkflowExecutionContext, WorkflowPageRequest } from '../../../common/workflow-runs.js';
import { readTextStreamWithLimit } from '../../common/bounded-text-stream.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import { isCurrentBrowserPrincipal } from '../auth/token.js';
import { markRouteResponseHeaders } from '../lib/http-route.js';
import type { HttpRouteContext, RouteHandler, RouteMap } from '../lib/http-route-types.js';
import type { WorkflowEngine, WorkflowSettingsResolver } from '../workflows/engine.js';
import {
  mergeExecutionContext, normalizeAddItem, normalizeAddStep, normalizeArchive, normalizeDecision, normalizePublish, normalizeRetry,
  normalizeStart, normalizeTest, workflowIdentifier,
} from '../workflows/requests.js';

export type WorkflowHttpService = Pick<WorkflowEngine,
  'publish' | 'listDefinitions' | 'getRevision' | 'testWorkflowDraft' | 'startRun' | 'getRun' |
  'listRuns' | 'listActiveChats' | 'addItem' | 'addStep' | 'decide' | 'retry' | 'archiveRun' | 'replayStartRun' | 'replayTestWorkflowDraft'>;

const bodyLimit = 2 * 1024 * 1024;
const workflowHeaders = { 'Cache-Control': 'no-store' };

function actor(context: HttpRouteContext | undefined, requireHuman: boolean): WorkflowActor {
  const who = context?.principal;
  if (!who || who.mode === 'executor' || !isCurrentBrowserPrincipal(who)) {
    throw new DomainError('WORKFLOW_FORBIDDEN', 'Use a current workspace session to access workflows.', 403);
  }
  if (requireHuman && who.mode !== 'authenticated') {
    throw new DomainError('WORKFLOW_FORBIDDEN', 'Sign in through Garcon to record a human workflow decision.', 403);
  }
  context?.assertCurrent?.();
  return { id: who.key, name: who.username };
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ValidationDomainError('Send this workflow request as application/json.');
  }
  const tooLarge = () => new DomainError('WORKFLOW_LIMIT', 'Workflow request exceeds 2 MiB.', 413);
  if (Number(request.headers.get('content-length')) > bodyLimit) throw tooLarge();
  const data = await readTextStreamWithLimit(request.body, bodyLimit, tooLarge);
  try { return JSON.parse(data); }
  catch { throw new ValidationDomainError('Workflow request is not valid JSON.'); }
}

function read(handler: (url: URL) => unknown): RouteHandler {
  return markRouteResponseHeaders((_request, url, _server, context) => {
    try {
      actor(context, false);
      return Response.json(handler(url));
    } catch (error) { return jsonErrorFromUnknown(error); }
  }, workflowHeaders);
}

function page(params: URLSearchParams): WorkflowPageRequest {
  const limit = params.get('limit'), cursor = params.get('cursor');
  return { ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }) };
}

function mutate(handler: (value: unknown, caller: WorkflowActor, assertCurrent: () => void) => Response | Promise<Response>, requireHuman = false): RouteHandler {
  return markRouteResponseHeaders(async (request, _url, _server, context) => {
    try {
      actor(context, requireHuman);
      const body = await readBody(request);
      request.signal.throwIfAborted();
      return await handler(body, actor(context, requireHuman), () => {
        request.signal.throwIfAborted();
        actor(context, requireHuman);
      });
    } catch (error) { return jsonErrorFromUnknown(error); }
  }, workflowHeaders);
}

function invalidSource(diagnostics: readonly WorkflowDiagnostic[], fallback: string): Response {
  return Response.json({ success: false, errorCode: 'VALIDATION_FAILED',
    error: diagnostics[0]?.message ?? fallback, retryable: false, diagnostics }, { status: 422 });
}

async function withDefinition(source: string, consume: (definition: WorkflowDefinition) => unknown): Promise<Response> {
  const { definition, diagnostics } = parseWorkflowDefinition(source);
  if (!definition) return invalidSource(diagnostics, 'Invalid workflow definition.');
  return Response.json(await consume(definition), { status: 201 });
}

export type PrepareWorkflowSettings = (steps: readonly WorkflowStep[], context: WorkflowExecutionContext) => Promise<WorkflowSettingsResolver>;

export function createWorkflowRoutes(runtime: { readonly service: WorkflowHttpService; prepareSettings: PrepareWorkflowSettings }): RouteMap {
  function changeRun<T extends { runId: string }>(
    normalize: (raw: unknown) => T,
    apply: (service: WorkflowHttpService, request: T, actor: WorkflowActor) => void,
    requireHuman = false,
  ): RouteHandler {
    return mutate((raw, who) => {
      const request = normalize(raw);
      const service = runtime.service;
      apply(service, request, who);
      return Response.json(service.getRun(request.runId));
    }, requireHuman);
  }

  return {
    [workflowPaths.definitions]: {
      GET: read(url => runtime.service.listDefinitions(page(url.searchParams))),
      POST: mutate(raw => {
        const request = normalizePublish(raw);
        return withDefinition(request.source, def => runtime.service.publish(request, def));
      }),
    },
    [workflowPaths.revision]: { GET: read(url => {
      const rev = url.searchParams.get('revision');
      if (rev !== null && (!/^[1-9]\d*$/u.test(rev) || !Number.isSafeInteger(Number(rev)))) {
        throw new ValidationDomainError('revision must be a positive integer.');
      }
      return runtime.service.getRevision(workflowIdentifier(url.searchParams.get('definitionId'), 'definitionId'),
        rev === null ? undefined : Number(rev));
    }) },
    [workflowPaths.runs]: {
      GET: read(url => runtime.service.listRuns(page(url.searchParams))),
      POST: mutate(async (raw, _who, assertCurrent) => {
        const request = normalizeStart(raw);
        const service = runtime.service;
        const prior = service.replayStartRun(request);
        if (prior) return Response.json(service.getRun(prior.id));
        const revision = service.getRevision(request.definitionId, request.revision);
        const snapshot = await runtime.prepareSettings(revision.definition.steps, request.executionContext ?? {});
        assertCurrent();
        const run = service.startRun(request, snapshot, revision);
        return Response.json(service.getRun(run.id), { status: 201 });
      }),
    },
    [workflowPaths.run]: { GET: read(url => runtime.service.getRun(workflowIdentifier(url.searchParams.get('runId'), 'runId'))) },
    [workflowPaths.activeChats]: { GET: read(url => runtime.service.listActiveChats(page(url.searchParams))) },
    [workflowPaths.testDraft]: { POST: mutate((raw, _who, assertCurrent) => {
      const request = normalizeTest(raw);
      const service = runtime.service;
      const prior = service.replayTestWorkflowDraft(request);
      if (prior) return Response.json(service.getRun(prior.id));
      return withDefinition(request.source, async def => {
        const snapshot = await runtime.prepareSettings(def.steps, request.executionContext ?? {});
        assertCurrent();
        return service.getRun(service.testWorkflowDraft(request, def, snapshot).id);
      });
    }) },
    [workflowPaths.decide]: { POST: changeRun(normalizeDecision, (service, request, who) => service.decide(request, who), true) },
    [workflowPaths.addItem]: { POST: changeRun(normalizeAddItem, (service, request, who) => service.addItem(request, who)) },
    [workflowPaths.addStep]: { POST: mutate(async (raw, who, assertCurrent) => {
      const request = normalizeAddStep(raw);
      const service = runtime.service;
      const run = service.getRun(request.runId);
      // A confirmed addition must remain retryable even after its inserted step now exists.
      if (run.amendments.some(added => added.operationId === request.operationId)) {
        service.addStep(request, who);
        return Response.json(run);
      }
      const evidence = request.evidenceSignalId ? run.signals.find(item => item.id === request.evidenceSignalId) : null;
      if (request.evidenceSignalId && !evidence) throw new ValidationDomainError('Select a signal occurrence from this run.');
      const parsed = parseWorkflowStepAddition({ ...run.pinnedRevision.definition, steps: run.steps.map(entry => entry.step) }, request.source, { evidence: evidence?.ref });
      if (!parsed.step) return invalidSource(parsed.diagnostics, 'Invalid step.');
      const context = mergeExecutionContext(run.executionContext, request.executionContext);
      const snapshot = await runtime.prepareSettings([parsed.step], context);
      assertCurrent();
      service.addStep(request, who, snapshot);
      return Response.json(service.getRun(run.id));
    }) },
    [workflowPaths.retry]: { POST: changeRun(normalizeRetry, (service, request, who) => service.retry(request, who)) },
    [workflowPaths.archive]: { POST: changeRun(normalizeArchive, (service, request, who) => service.archiveRun(request, who)) },
  };
}
