import type { WorkflowAttempt, WorkflowPlanTask } from '../../../common/workflows.js';
import type { WorkflowEffectFence, WorkflowIntegrationRepositoryPort, WorkflowIntegrationResult } from './contracts.js';
import { WorkflowEvidenceSettlement } from './evidence-settlement.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { requireIntegrationOperation } from './integration-manifest.js';
import { matchesManagedTarget } from './managed-target.js';

export class WorkflowIntegrationEvidence {
  constructor(private readonly settlement: WorkflowEvidenceSettlement, private readonly repository: WorkflowIntegrationRepositoryPort,
    private readonly now: () => string) {}

  async capture(initial: WorkflowAttempt, task: WorkflowPlanTask, operationId: string,
    fence: WorkflowEffectFence, signal: AbortSignal): Promise<{ commit(): void }> {
    const attempt = this.settlement.requireAttempt(initial, task, fence, signal);
    const captured = this.settlement.store.read(db => requireIntegrationOperation(db, attempt, operationId));
    const result: WorkflowIntegrationResult = captured.operation.result ? JSON.parse(captured.operation.result) : null;
    if (captured.operation.status !== 'succeeded' || result?.kind !== 'integrated'
      || result.executorId !== attempt.target!.executorId || result.instanceId !== attempt.managedTarget!.instanceId
      || !matchesManagedTarget(attempt.managedTarget!, result.managed) || result.managed.dirty) {
      return workflowConflict('Integration has no exact observed successful result.');
    }
    const observation = structuredClone(await this.repository.inspect(attempt.managedTarget!, captured.manifest.request.commits, signal));
    const observedAt = this.now();
    return { commit: () => this.settlement.commit(attempt, task, fence, signal, (db, current) => {
      const settled = requireIntegrationOperation(db, current, operationId);
      if (workflowDigest(settled) !== workflowDigest(captured)) return workflowConflict('Integration result changed during capture.');
      const resource = current.managedTarget!;
      const managed = observation.managed;
      const pass = observation.executorId === resource.target.executorId && observation.instanceId === resource.instanceId
        && matchesManagedTarget(resource, managed) && !managed.dirty && managed.head === result.managed.head
        && observation.commit.commit === managed.head && observation.commit.containsAncestor === true
        && observation.lineage.length === captured.manifest.inputs.length
        && observation.lineage.every((entry, index) => entry.commit === captured.manifest.inputs[index]!.commit && entry.containsAncestor === true);
      return [{ kind: 'commit', provenance: 'runtime-observed', outcome: pass ? 'pass' : 'unknown',
        summary: pass ? 'Exact ordered integration and all input ancestry observed.' : 'Integration identity, head, cleanliness or lineage changed.',
        executorId: observation.executorId, repositoryId: resource.target.repositoryId, commit: managed.head, dirty: managed.dirty, url: null,
        commandOutcome: null, receivedOutputCoverage: 'unknown', observedAt,
        git: { scope: 'managed-integration', operationId, manifestDigest: captured.digest, inputs: captured.manifest.inputs,
          runtimeInstanceId: observation.instanceId, repositoryIdentity: managed.repositoryIdentity, worktreeIdentity: managed.worktreeIdentity,
          projectPath: managed.worktreePath, inputCommit: resource.head, inputTree: resource.baseTree,
          outputTree: observation.commit.tree, containsInput: observation.commit.containsAncestor } }];
    }) };
  }
}
