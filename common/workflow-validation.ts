import { parseAgentSettingsEnvelope } from './agent-integration.js';
import { isPermissionMode, isThinkingMode } from './chat-modes.js';
import { isExecutorId } from './executors.js';
import { isRecord } from './json.js';
import { isPreambleId } from './preambles.js';
import { parseChatId } from './chat-id.js';
import { WORKFLOW_LIMITS, type WorkflowAcceptance, type WorkflowAgentSelection, type WorkflowMutation,
  type WorkflowMutationRequest, type WorkflowOutputRequirement, type WorkflowPlan, type WorkflowPlanTask,
  type WorkflowRepositoryTarget, type WorkflowTaskSpec } from './workflows.js';

export class WorkflowValidationError extends Error {}
export function workflowInvalid(message: string): never { throw new WorkflowValidationError(message); }
export function workflowBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export function workflowRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) return workflowInvalid('Unexpected workflow fields.');
  return value;
}
export function workflowText(value: unknown, name: string, bytes = 4096): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.includes('\0')
    || new TextEncoder().encode(value).byteLength > bytes) return workflowInvalid(`Invalid ${name}.`);
  return value;
}
export function workflowId(value: unknown): string {
  const id = workflowText(value, 'identity', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) return workflowInvalid('Invalid workflow identity.');
  return id;
}
export function workflowInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return workflowInvalid('Invalid workflow integer.');
  return value;
}
export function workflowBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return workflowInvalid('Expected a boolean.');
  return value;
}
export function workflowEnum<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return workflowInvalid('Unsupported workflow value.');
  return value as T;
}
export function workflowList<T>(value: unknown, parse: (item: unknown) => T, max: number = WORKFLOW_LIMITS.tasks): T[] {
  if (!Array.isArray(value) || value.length > max) return workflowInvalid('Invalid or oversized workflow list.');
  return value.map(parse);
}
export function workflowDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) return workflowInvalid('Expected SHA-256 digest.');
  return value;
}
export function workflowCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return workflowInvalid('Expected full commit identity.');
  return value;
}
function ids(value: unknown): string[] {
  const list = workflowList(value, workflowId);
  if (new Set(list).size !== list.length) return workflowInvalid('Duplicate references.');
  return list;
}
function branch(value: unknown): string {
  const ref = workflowText(value, 'branch', 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u.test(ref) || ref.includes('..') || ref.includes('//')
    || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock') || ref.includes('/.')) return workflowInvalid('Invalid branch.');
  return ref;
}
export function parseWorkflowRepository(value: unknown): WorkflowRepositoryTarget {
  const raw = workflowRecord(value, ['executorId', 'projectPath', 'repositoryId', 'baseCommit', 'inputTaskId', 'worktreeRoot', 'remote']);
  if (!isExecutorId(raw.executorId)) return workflowInvalid('An explicit executor is required.');
  let remote: WorkflowRepositoryTarget['remote'] = null;
  if (raw.remote !== null) {
    const selected = workflowRecord(raw.remote, ['name', 'url']);
    const url = workflowText(selected.url, 'remote URL');
    // Credentials are never a repository identity or an approval input.
    if (!/^(?:https:\/\/[^/@:]+\/|ssh:\/\/[^/:]+(?:@[^/:]+)?\/|git@[^:]+:)/u.test(url)) {
      return workflowInvalid('Use a credential-free HTTPS or SSH Git remote.');
    }
    remote = { name: branch(selected.name), url };
  }
  return { executorId: raw.executorId, projectPath: workflowText(raw.projectPath, 'project path'),
    repositoryId: workflowText(raw.repositoryId, 'repository identity'), baseCommit: workflowCommit(raw.baseCommit),
    inputTaskId: raw.inputTaskId === null ? null : workflowId(raw.inputTaskId),
    worktreeRoot: workflowText(raw.worktreeRoot, 'managed worktree root'), remote };
}
function selection(value: unknown): WorkflowAgentSelection {
  const raw = workflowRecord(value, ['agentId', 'model', 'apiProviderId', 'modelEndpointId', 'modelProtocol',
    'providerRevision', 'permissionMode', 'thinkingMode', 'agentSettings', 'preambles']);
  const agentId = workflowId(raw.agentId);
  const agentSettings = parseAgentSettingsEnvelope(raw.agentSettings);
  if (!agentSettings || agentSettings.ownerId !== agentId || !isPermissionMode(raw.permissionMode)
    || !isThinkingMode(raw.thinkingMode)) return workflowInvalid('Invalid execution settings.');
  const apiProviderId = raw.apiProviderId === null ? null : workflowId(raw.apiProviderId);
  const modelEndpointId = raw.modelEndpointId === null ? null : workflowId(raw.modelEndpointId);
  const modelProtocol = raw.modelProtocol === null ? null : workflowEnum(raw.modelProtocol, ['anthropic-messages', 'openai-compatible']);
  const providerRevision = raw.providerRevision === null ? null : workflowInteger(raw.providerRevision, 1);
  if (apiProviderId === null ? modelEndpointId !== null || modelProtocol !== null || providerRevision !== null
    : modelEndpointId === null || modelProtocol === null || providerRevision === null) return workflowInvalid('Incomplete provider selection.');
  const preambles = workflowList(raw.preambles, item => {
    const entry = workflowRecord(item, ['id', 'contentDigest']);
    if (!isPreambleId(entry.id)) return workflowInvalid('Invalid preamble.');
    return { id: entry.id, contentDigest: workflowDigest(entry.contentDigest) };
  }, 100);
  if (new Set(preambles.map(item => item.id)).size !== preambles.length) return workflowInvalid('Duplicate preamble.');
  return { agentId, model: workflowText(raw.model, 'model', 512), apiProviderId, modelEndpointId,
    modelProtocol, providerRevision, permissionMode: raw.permissionMode, thinkingMode: raw.thinkingMode, agentSettings, preambles };
}
function output(value: unknown): WorkflowOutputRequirement { return workflowEnum(value, ['commit', 'summary', 'review']); }
function acceptance(value: unknown): WorkflowAcceptance {
  if (!isRecord(value)) return workflowInvalid('Invalid acceptance requirement.');
  if (value.kind === 'artifact') {
    const raw = workflowRecord(value, ['kind', 'output']);
    return { kind: 'artifact', output: output(raw.output) };
  }
  const raw = workflowRecord(value, ['kind', 'taskId']);
  return { kind: workflowEnum(raw.kind, ['independent-review', 'approval']), taskId: workflowId(raw.taskId) };
}
function spec(value: unknown): WorkflowTaskSpec {
  if (!isRecord(value)) return workflowInvalid('Invalid task specification.');
  switch (value.kind) {
    case 'agent': {
      const raw = workflowRecord(value, ['kind', 'target', 'selection', 'prompt', 'outputs']);
      return { kind: 'agent', target: parseWorkflowRepository(raw.target), selection: selection(raw.selection),
        prompt: workflowText(raw.prompt, 'prompt', WORKFLOW_LIMITS.promptBytes), outputs: workflowList(raw.outputs, output, 3) };
    }
    case 'command': {
      const raw = workflowRecord(value, ['kind', 'target', 'shellModel', 'command', 'timeoutMs', 'expectedExitCode', 'outputRequirement']);
      return { kind: 'command', target: parseWorkflowRepository(raw.target), shellModel: workflowText(raw.shellModel, 'shell', 128),
        command: workflowText(raw.command, 'command', WORKFLOW_LIMITS.promptBytes), timeoutMs: workflowInteger(raw.timeoutMs, 1000, 3600000),
        expectedExitCode: workflowInteger(raw.expectedExitCode, 0, 255), outputRequirement: workflowEnum(raw.outputRequirement, ['full-log', 'exit-status-only']) };
    }
    case 'integrate': {
      const raw = workflowRecord(value, ['kind', 'target', 'strategy', 'inputs']);
      return { kind: 'integrate', target: parseWorkflowRepository(raw.target), strategy: workflowEnum(raw.strategy, ['ordered-merge']), inputs: ids(raw.inputs) };
    }
    case 'approval': {
      const raw = workflowRecord(value, ['kind', 'purpose', 'requirements']);
      return { kind: 'approval', purpose: workflowEnum(raw.purpose, ['publication', 'manual']), requirements: ids(raw.requirements) };
    }
    case 'publish-pr': {
      const raw = workflowRecord(value, ['kind', 'target', 'sourceTaskId', 'approvalTaskId', 'baseBranch', 'headBranch', 'title', 'body', 'draft']);
      return { kind: 'publish-pr', target: parseWorkflowRepository(raw.target), sourceTaskId: workflowId(raw.sourceTaskId),
        approvalTaskId: workflowId(raw.approvalTaskId), baseBranch: branch(raw.baseBranch), headBranch: branch(raw.headBranch),
        title: workflowText(raw.title, 'PR title', 256), body: workflowText(raw.body, 'PR body', 48 * 1024), draft: workflowBoolean(raw.draft) };
    }
    default: return workflowInvalid('Unsupported task kind.');
  }
}
function task(value: unknown): WorkflowPlanTask {
  const raw = workflowRecord(value, ['id', 'title', 'dependsOn', 'spec', 'acceptance', 'retry']);
  const retry = workflowRecord(raw.retry ?? { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false }, ['maxAttempts', 'backoffMs', 'repeatableFailure']);
  const maxAttempts = workflowInteger(retry.maxAttempts, 1, 2);
  const repeatableFailure = workflowBoolean(retry.repeatableFailure);
  if (maxAttempts > 1 && !repeatableFailure) return workflowInvalid('Retries require explicitly repeatable failures.');
  return { id: workflowId(raw.id), title: workflowText(raw.title, 'task title', 256), dependsOn: ids(raw.dependsOn), spec: spec(raw.spec),
    acceptance: workflowList(raw.acceptance, acceptance, 32), retry: { maxAttempts, repeatableFailure, backoffMs: workflowInteger(retry.backoffMs, 1000, 300000) } };
}
export function parseWorkflowPlan(value: unknown): WorkflowPlan {
  if (workflowBytes(value) > WORKFLOW_LIMITS.planBytes) return workflowInvalid('Plan exceeds its encoded size limit.');
  const raw = workflowRecord(value, ['title', 'goal', 'policy', 'tasks']);
  const goal = workflowRecord(raw.goal, ['kind', 'taskIds']);
  const policy = workflowRecord(raw.policy, ['allowRemoteWrites', 'concurrency']);
  const tasks = workflowList(raw.tasks, task);
  if (!tasks.length) return workflowInvalid('A workflow requires tasks.');
  return { title: workflowText(raw.title, 'title', 256),
    goal: { kind: workflowEnum(goal.kind, ['artifacts', 'pr-open']), taskIds: ids(goal.taskIds) },
    policy: { allowRemoteWrites: workflowBoolean(policy.allowRemoteWrites), concurrency: workflowInteger(policy.concurrency, 1, WORKFLOW_LIMITS.workflowAttempts) }, tasks };
}

export function parseWorkflowMutationRequest(value: unknown): WorkflowMutationRequest {
  const raw = workflowRecord(value, ['operationId', 'mutation']);
  return { operationId: workflowId(raw.operationId), mutation: parseWorkflowMutation(raw.mutation) };
}
function parseWorkflowMutation(value: unknown): WorkflowMutation {
  if (!isRecord(value)) return workflowInvalid('Invalid workflow mutation.');
  if (value.action === 'create') {
    const raw = workflowRecord(value, ['action', 'plan', 'captainChatId']);
    return { action: 'create', plan: parseWorkflowPlan(raw.plan), captainChatId: raw.captainChatId == null ? null : parseChatId(raw.captainChatId) };
  }
  const workflow = workflowId(value.workflowId);
  switch (value.action) {
    case 'plan': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'expectedPlanRevision', 'plan']);
      return { action: 'plan', workflowId: workflow, expectedPlanRevision: workflowInteger(raw.expectedPlanRevision, 1), plan: parseWorkflowPlan(raw.plan) };
    }
    case 'activate': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'manifestDigest']);
      return { action: 'activate', workflowId: workflow, manifestDigest: workflowDigest(raw.manifestDigest) };
    }
    case 'pause': case 'stop': case 'cancel': case 'archive':
      workflowRecord(value, ['action', 'workflowId']);
      return { action: value.action, workflowId: workflow };
    case 'resume': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'controlEpoch', 'planRevision']);
      return { action: 'resume', workflowId: workflow, controlEpoch: workflowInteger(raw.controlEpoch), planRevision: workflowInteger(raw.planRevision, 1) };
    }
    case 'approve': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'gateId', 'manifestDigest', 'decision']);
      return { action: 'approve', workflowId: workflow, gateId: workflowId(raw.gateId), manifestDigest: workflowDigest(raw.manifestDigest), decision: workflowEnum(raw.decision, ['approve', 'reject']) };
    }
    case 'retry': case 'resolve': {
      const raw = workflowRecord(value, value.action === 'retry' ? ['action', 'workflowId', 'taskId', 'generation', 'attemptId']
        : ['action', 'workflowId', 'taskId', 'generation', 'attemptId', 'resolution', 'evidence', 'commit', 'releaseRisk']);
      const identity = { workflowId: workflow, taskId: workflowId(raw.taskId), generation: workflowInteger(raw.generation, 1), attemptId: workflowId(raw.attemptId) };
      if (value.action === 'retry') return { action: 'retry', ...identity };
      const resolution = workflowEnum(raw.resolution, ['not-started', 'abandon', 'adopt']);
      if (resolution === 'adopt' ? raw.releaseRisk !== false : raw.commit !== null) workflowInvalid('Resolution has incompatible commit or risk-release fields.');
      return { action: 'resolve', ...identity, resolution,
        evidence: workflowText(raw.evidence, 'resolution evidence', 8192), commit: raw.commit === null ? null : workflowCommit(raw.commit), releaseRisk: workflowBoolean(raw.releaseRisk) };
    }
    case 'clear-hold': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'taskId', 'generation', 'evidence']);
      return { action: 'clear-hold', workflowId: workflow, taskId: workflowId(raw.taskId), generation: workflowInteger(raw.generation, 1),
        evidence: workflowText(raw.evidence, 'resolution evidence', 8192) };
    }
    case 'recheck-publication': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'attemptId', 'publicationOperationId']);
      return { action: 'recheck-publication', workflowId: workflow, attemptId: workflowId(raw.attemptId),
        publicationOperationId: workflowId(raw.publicationOperationId) };
    }
    case 'cleanup': {
      const raw = workflowRecord(value, ['action', 'workflowId', 'attemptId', 'resourceKey', 'expectedHead']);
      return { action: 'cleanup', workflowId: workflow, attemptId: workflowId(raw.attemptId),
        resourceKey: workflowText(raw.resourceKey, 'resource key', 4096), expectedHead: workflowCommit(raw.expectedHead) };
    }
    default: return workflowInvalid('Unsupported workflow action.');
  }
}
