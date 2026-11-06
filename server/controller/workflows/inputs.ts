import { createHash } from 'node:crypto';
import { stableJsonStringify } from '../../../common/json.js';
import { AUTOMATION_PRESENTATION, GUARDED_AUTOMATION_POLICY, type AutomationStartInput,
  type EffectiveAutomationInput } from '../../../common/automation.js';
import type { WorkflowArtifact, WorkflowAttempt, WorkflowPlanTask, WorkflowRepositoryTarget } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { workflowAgentPrompt } from './agent-output.js';

export function workflowDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

export type WorkflowDependencyArtifact = Pick<WorkflowArtifact, 'id' | 'digest' | 'commit' | 'kind' | 'outcome' | 'provenance' | 'executorId' | 'repositoryId' | 'dirty'> & {
  readonly attempt: Pick<WorkflowArtifact['attempt'], 'taskId'>;
  readonly gitScope?: NonNullable<WorkflowArtifact['git']>['scope'] | null;
};

export function workflowResolvedTarget(task: WorkflowPlanTask, dependencies: readonly WorkflowDependencyArtifact[]) {
  if (!('target' in task.spec)) return workflowConflict('Task has no repository target.');
  const target = task.spec.target;
  if (task.spec.kind === 'integrate') {
    task.spec.inputs.forEach(id => workflowCommitInput(id, target.repositoryId, dependencies));
    return target;
  }
  const inputTaskId = task.spec.kind === 'publish-pr' ? task.spec.sourceTaskId : target.inputTaskId;
  if (inputTaskId === null) return target;
  return { ...target, baseCommit: workflowCommitInput(inputTaskId, target.repositoryId, dependencies).commit! };
}

export function workflowCommitInput(taskId: string, repositoryId: string, dependencies: readonly WorkflowDependencyArtifact[]) {
  const commits = dependencies.filter(artifact => artifact.attempt.taskId === taskId && artifact.kind === 'commit'
    && artifact.outcome === 'pass' && (artifact.provenance === 'runtime-observed'
      || artifact.provenance === 'operator-attested' && artifact.gitScope === 'operator-adopted') && artifact.dirty === false
    && artifact.repositoryId === repositoryId && artifact.commit !== null);
  if (commits.length !== 1) return workflowConflict('Repository input requires exactly one accepted commit artifact.');
  return commits[0]!;
}

export function workflowCommitInputIds(task: WorkflowPlanTask): readonly string[] {
  if (task.spec.kind === 'integrate') return task.spec.inputs;
  if (task.spec.kind === 'publish-pr') return [task.spec.sourceTaskId];
  return 'target' in task.spec && task.spec.target.inputTaskId !== null ? [task.spec.target.inputTaskId] : [];
}

export function workflowNeedsTransfer(source: WorkflowRepositoryTarget, destination: WorkflowRepositoryTarget): boolean {
  return source.executorId !== destination.executorId || source.projectPath !== destination.projectPath;
}

export function workflowInputDigest(task: WorkflowPlanTask, dependencies: readonly WorkflowDependencyArtifact[]): string {
  return workflowDigest({ task, inputs: task.dependsOn.map(taskId => ({ taskId,
    artifacts: dependencies.filter(artifact => artifact.attempt.taskId === taskId)
      .map(artifact => ({ id: artifact.id, digest: artifact.digest, commit: artifact.commit }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })) });
}

export function workflowStartInput(attempt: WorkflowAttempt, task: WorkflowPlanTask): AutomationStartInput {
  const spec = task.spec;
  if (!attempt.target || (spec.kind !== 'agent' && spec.kind !== 'command')) {
    return workflowConflict('This task does not admit a chat turn.');
  }
  const selection = spec.kind === 'agent' ? spec.selection : {
    agentId: 'shell', model: spec.shellModel, apiProviderId: null, modelEndpointId: null,
    modelProtocol: null, providerRevision: null, permissionMode: 'default' as const,
    thinkingMode: 'none' as const, agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, preambles: [],
  };
  return { ...selection, clientRequestId: attempt.requestId, title: task.title,
    executorId: attempt.target.executorId, projectPath: attempt.target.projectPath,
    command: spec.kind === 'agent' ? workflowAgentPrompt(spec, attempt.target.baseCommit) : spec.command,
    presentation: AUTOMATION_PRESENTATION, automationPolicy: GUARDED_AUTOMATION_POLICY };
}

export function workflowEffectiveInput(input: AutomationStartInput): EffectiveAutomationInput {
  if (!input.executorId) return workflowConflict('Automation input requires an explicit executor.');
  const manifest = {
    executorId: input.executorId, projectPath: input.projectPath,
    promptDigest: `sha256:${createHash('sha256').update(input.command).digest('hex')}`,
    preambles: input.preambles,
    selectionDigest: workflowDigest({ agentId: input.agentId, model: input.model,
      apiProviderId: input.apiProviderId ?? null, modelEndpointId: input.modelEndpointId ?? null }),
    providerRevision: input.providerRevision,
    settingsDigest: workflowDigest({ permissionMode: input.permissionMode,
      thinkingMode: input.thinkingMode, agentSettings: input.agentSettings }),
  };
  return { ...manifest, digest: workflowDigest(manifest) };
}
