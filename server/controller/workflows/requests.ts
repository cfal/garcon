import { createHash } from 'node:crypto';
import { isExecutorId } from '../../../common/executors.js';
import { isRecord, stableJsonStringify, type JsonObject, type JsonValue } from '../../../common/json.js';
import type {
  WorkflowActor, WorkflowAddItemRequest, WorkflowAddStepRequest, WorkflowDecisionRequest, WorkflowExecutionContext,
  WorkflowLocation, WorkflowPageRequest, WorkflowPublishRequest, WorkflowRetryRequest, WorkflowStartRequest, WorkflowTestRequest,
} from '../../../common/workflow-runs.js';
import { workflowInvalid, workflowLimit } from './errors.js';
import { WORKFLOW_LIMITS } from './limits.js';

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw workflowInvalid(`${name} has unexpected fields or is not an object.`);
  }
  return value;
}

export function workflowIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.includes('\0')) {
    throw workflowInvalid(`${name} must be a nonempty string of at most 128 characters.`);
  }
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw workflowInvalid('Workflow revision must be a positive integer.');
  }
  return value;
}

function path(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) {
    throw workflowInvalid('A project path must be a nonempty string of at most 4096 characters.');
  }
  return value;
}

export function normalizeExecutionContext(value: unknown): WorkflowExecutionContext {
  if (value === undefined) return {};
  const body = record(value, 'Workflow execution context', ['defaultTarget', 'projectPaths']);
  let defaultTarget: WorkflowLocation | undefined;
  let projectPaths: Record<string, string> | undefined;
  if (body.defaultTarget !== undefined) {
    const target = record(body.defaultTarget, 'Workflow default target', ['executorId', 'projectPath']);
    if (!isExecutorId(target.executorId)) throw workflowInvalid('The default target requires a valid executor id.');
    defaultTarget = { executorId: target.executorId, projectPath: path(target.projectPath) };
  }
  if (body.projectPaths !== undefined) {
    if (!isRecord(body.projectPaths)) throw workflowInvalid('Workflow project paths must be keyed by executor id.');
    const paths = Object.entries(body.projectPaths);
    if (paths.length > WORKFLOW_LIMITS.steps) throw workflowLimit('Too many executor project paths.');
    projectPaths = Object.fromEntries(paths.map(([executorId, projectPath]) => {
      if (!isExecutorId(executorId)) throw workflowInvalid('Workflow project paths must use valid executor ids.');
      return [executorId, path(projectPath)];
    }));
  }
  return { ...(defaultTarget && { defaultTarget }), ...(projectPaths && { projectPaths }) };
}

export function workflowSource(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw workflowInvalid('Workflow source must be a nonempty string.');
  if (Buffer.byteLength(value) > WORKFLOW_LIMITS.sourceBytes) throw workflowLimit('Workflow source exceeds the size limit.');
  return value;
}

// Rejects non-JSON values before serialization can silently omit or coerce them.
export function workflowJson(value: unknown, subject: string): string {
  let nodes = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 16_384 || depth > 32 || bytes > WORKFLOW_LIMITS.valueBytes) {
      throw workflowLimit(`${subject} exceeds the JSON size limit.`);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); return; }
    if (Array.isArray(item)) {
      for (const element of item) visit(element, depth + 1);
      return;
    }
    if (isRecord(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const key of Object.keys(item)) {
        bytes += Buffer.byteLength(key);
        visit(item[key], depth + 1);
      }
      return;
    }
    throw workflowInvalid(`${subject} must be valid JSON.`);
  };
  visit(value, 0);
  if (bytes > WORKFLOW_LIMITS.valueBytes) throw workflowLimit(`${subject} exceeds the JSON size limit.`);
  const json = stableJsonStringify(value);
  if (Buffer.byteLength(json) > WORKFLOW_LIMITS.valueBytes) throw workflowLimit(`${subject} exceeds the JSON size limit.`);
  return json;
}

const launchKeys = ['inputs', 'executionContext', 'operationId'];
function launchFields(body: Record<string, unknown>) {
  if (!isRecord(body.inputs)) throw workflowInvalid('Workflow inputs must be an object.');
  return {
    inputs: JSON.parse(workflowJson(body.inputs, 'Workflow inputs')) as JsonObject,
    executionContext: normalizeExecutionContext(body.executionContext),
    ...(body.operationId !== undefined && { operationId: workflowIdentifier(body.operationId, 'Operation id') }),
  };
}

export function normalizeStart(value: unknown): WorkflowStartRequest {
  const body = record(value, 'Workflow start', [...launchKeys, 'definitionId', 'revision']);
  return {
    ...launchFields(body),
    definitionId: workflowIdentifier(body.definitionId, 'Definition id'),
    ...(body.revision !== undefined && { revision: revision(body.revision) }),
  };
}

export function normalizeTest(value: unknown): WorkflowTestRequest {
  const body = record(value, 'Workflow test', [...launchKeys, 'source']);
  return { ...launchFields(body), source: workflowSource(body.source) };
}

export function normalizePublish(value: unknown): WorkflowPublishRequest {
  const body = record(value, 'Workflow publish', ['definitionId', 'expectedRevision', 'source']);
  return {
    definitionId: workflowIdentifier(body.definitionId, 'Definition id'),
    expectedRevision: body.expectedRevision === null ? null : revision(body.expectedRevision),
    source: workflowSource(body.source),
  };
}

const operationKeys = ['runId', 'operationId'];
function operation(body: Record<string, unknown>) {
  return {
    runId: workflowIdentifier(body.runId, 'Run id'),
    operationId: workflowIdentifier(body.operationId, 'Operation id'),
  };
}

export function normalizeDecision(value: unknown): WorkflowDecisionRequest {
  const body = record(value, 'Workflow decision', [...operationKeys, 'instanceId', 'choice']);
  return { ...operation(body), instanceId: workflowIdentifier(body.instanceId, 'Instance id'),
    choice: workflowIdentifier(body.choice, 'Decision choice') };
}

export function normalizeAddItem(value: unknown): WorkflowAddItemRequest {
  const body = record(value, 'Workflow add item', [...operationKeys, 'stepId', 'key', 'payload']);
  return { ...operation(body), stepId: workflowIdentifier(body.stepId, 'Step id'),
    key: workflowIdentifier(body.key, 'Repeat key'),
    payload: JSON.parse(workflowJson(body.payload, 'Signal payload')) as JsonValue };
}

export function normalizeAddStep(value: unknown): WorkflowAddStepRequest {
  const body = record(value, 'Workflow add step', [...operationKeys, 'source', 'evidenceSignalId', 'executionContext']);
  return { ...operation(body), source: workflowSource(body.source),
    ...(body.evidenceSignalId !== undefined && { evidenceSignalId: workflowIdentifier(body.evidenceSignalId, 'Signal occurrence id') }),
    ...(body.executionContext !== undefined && { executionContext: normalizeExecutionContext(body.executionContext) }),
  };
}

export function normalizeRetry(value: unknown): WorkflowRetryRequest {
  const body = record(value, 'Workflow retry', [...operationKeys, 'instanceId']);
  return { ...operation(body), instanceId: workflowIdentifier(body.instanceId, 'Instance id') };
}

export function normalizeActor(actor: WorkflowActor): WorkflowActor {
  if (!isRecord(actor)) throw workflowInvalid('An authenticated human actor is required.');
  return { id: workflowIdentifier(actor.id, 'Actor id'), name: workflowIdentifier(actor.name, 'Actor name') };
}

export function requestHash(action: string, request: object, actor?: WorkflowActor): string {
  return createHash('sha256').update(stableJsonStringify([action, request, actor?.id ?? null])).digest('hex');
}

export function normalizePage(page: WorkflowPageRequest, maximum: number): { limit: number; cursor: string | null } {
  if (!isRecord(page)) throw workflowInvalid('A workflow page request must be an object.');
  const count = page.limit ?? maximum;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > maximum) {
    throw workflowInvalid(`Page size must be between 1 and ${maximum}.`);
  }
  return { limit: count, cursor: page.cursor === undefined ? null : workflowIdentifier(page.cursor, 'Page cursor') };
}
