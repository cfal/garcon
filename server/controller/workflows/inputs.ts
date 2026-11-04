import { createHash } from 'node:crypto';
import { stableJsonStringify } from '../../../common/json.js';
import { AUTOMATION_PRESENTATION, GUARDED_AUTOMATION_POLICY, type AutomationStartInput,
  type EffectiveAutomationInput } from '../../../common/automation.js';
import type { WorkflowArtifact, WorkflowAttempt, WorkflowPlanTask } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';

export function workflowDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

export type WorkflowDependencyArtifact = Pick<WorkflowArtifact, 'id' | 'digest' | 'commit'> & {
  readonly attempt: Pick<WorkflowArtifact['attempt'], 'taskId'>;
};

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
    command: spec.kind === 'agent' ? spec.prompt.trim() : spec.command,
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
