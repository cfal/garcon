import { createHash } from 'node:crypto';
import { stableJsonStringify } from '../../../common/json.js';
import type { WorkflowArtifact, WorkflowPlanTask } from '../../../common/workflows.js';

export function workflowDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

export function workflowInputDigest(task: WorkflowPlanTask, dependencies: readonly WorkflowArtifact[]): string {
  return workflowDigest({ task, inputs: task.dependsOn.map(taskId => ({ taskId,
    artifacts: dependencies.filter(artifact => artifact.attempt.taskId === taskId)
      .map(artifact => ({ id: artifact.id, digest: artifact.digest, commit: artifact.commit }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })) });
}
