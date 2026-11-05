import type { WorkflowAttempt, WorkflowRevocationKind } from '../../../common/workflows.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import { WorkflowAttempts, type WorkflowTerminalObservation } from './attempts.js';
import type { WorkflowEffectFence, WorkflowIntegrationRepositoryPort, WorkflowIntegrationResult, WorkflowRepositoryPort } from './contracts.js';
import { WorkflowEvidenceSettlement } from './evidence-settlement.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { WorkflowIntegrationEvidence } from './integration-evidence.js';
import { workflowIntegrationManifest } from './integration-manifest.js';
import { matchesManagedTarget } from './managed-target.js';
import { readPlan } from './records.js';
import { WorkflowResources } from './resources.js';

export class WorkflowIntegrationAdmission {
  readonly #active = new Map<string, { kind: WorkflowRevocationKind | null; observation: AbortController }>();
  readonly #evidence: WorkflowIntegrationEvidence;

  constructor(private readonly attempts: WorkflowAttempts, private readonly resources: WorkflowResources,
    private readonly repositories: WorkflowRepositoryPort, private readonly integration: WorkflowIntegrationRepositoryPort,
    options: { readonly now: () => string; readonly onInvalidated?: (workflowId: string, revision: number) => void }) {
    this.#evidence = new WorkflowIntegrationEvidence(new WorkflowEvidenceSettlement(attempts.store, options), integration, options.now);
  }

  async dispatch(initial: WorkflowAttempt, effect: WorkflowEffectFence): Promise<void> {
    if (this.#active.has(initial.attemptId)) return workflowConflict('Integration admission is already owned.');
    const active = { kind: null as WorkflowRevocationKind | null, observation: new AbortController() };
    this.#active.set(initial.attemptId, active);
    const fence: WorkflowEffectFence = {
      get revoked() { return active.kind !== null || effect.revoked; },
      get reason() { return active.kind ? 'Workflow integration control was revoked.' : effect.reason; },
      get revocationKind() { return active.kind === 'intervention' || effect.revocationKind === 'intervention'
        ? 'intervention' : active.kind ?? effect.revocationKind; },
      revokedSignal: AbortSignal.any([active.observation.signal, effect.revokedSignal]), shutdown: effect.shutdown,
    };
    let operationId: string | null = null;
    try {
      if (fence.revoked || fence.shutdown.aborted) workflowConflict('Integration preparation was canceled.');
      let attempt = this.attempts.beginPreparation(initial.attemptId);
      const task = this.attempts.store.read(db => readPlan(db, attempt.workflowId, attempt.planRevision)).plan.tasks.find(task => task.id === attempt.taskId)!;
      if (task.spec.kind !== 'integrate') workflowConflict('This task does not admit integration.');
      const prepared = await this.repositories.prepare(attempt, task, fence);
      if (prepared.kind !== 'prepared') {
        this.resources.interruptPreparation(attempt.attemptId);
        this.attempts.observe(attempt.attemptId, prepared.kind === 'held'
          ? { ...integrationObservation('not-started', prepared.detail), admissionHold: prepared.detail }
          : integrationObservation(prepared.kind, prepared.detail), fence);
        return;
      }
      attempt = this.attempts.bindTarget(attempt.attemptId, prepared.resource);
      const manifest = this.attempts.store.read(db => workflowIntegrationManifest(db, attempt));
      const plannedId = crypto.randomUUID();
      this.resources.plan({ operationId: plannedId, attemptId: attempt.attemptId, kind: 'integrate', resourceKey: prepared.resource.resourceKey,
        payload: JSON.stringify({ manifest, digest: workflowDigest(manifest) }) });
      operationId = plannedId;
      attempt = this.attempts.bindIntegrationPrepared(attempt.attemptId, operationId);
      const call = await this.integration.prepare(manifest, fence.shutdown);
      this.attempts.markIntegrationDispatching(attempt.attemptId, operationId, fence);
      if (fence.revoked || fence.shutdown.aborted) workflowConflict('Integration dispatch was canceled.');
      const result = await call.run();
      if (result.kind === 'not-started') {
        this.resources.observe(operationId, 'not-started', JSON.stringify({ kind: result.kind, reason: result.reason.slice(0, 1024) }));
        this.attempts.observe(attempt.attemptId, integrationObservation('not-started', result.reason), fence);
        return;
      }
      if (result.executorId !== manifest.resource.target.executorId || result.instanceId !== manifest.resource.instanceId
        || result.kind === 'unknown' || !matchesManagedTarget(manifest.resource, result.managed)
        || result.kind === 'integrated' && result.managed.dirty) throw new Error('Integration result could not be confirmed on its prepared runtime.');
      this.resources.observe(operationId, 'succeeded', JSON.stringify(boundedIntegrationResult(result)));
      attempt = this.attempts.observe(attempt.attemptId, integrationObservation(result.kind === 'integrated' ? 'checking' : 'failed',
        result.kind === 'integrated' ? 'Ordered integration completed.' : 'Integration conflicts retained in the managed worktree.'), fence);
      if (attempt.resolution !== 'open') return;
      const signal = AbortSignal.any([fence.shutdown, fence.revokedSignal,
        AbortSignal.timeout((manifest.inputs.length + 3) * GIT_OPERATION_TIMEOUT_MS)]);
      (await this.#evidence.capture(attempt, task, operationId, fence, signal)).commit();
    } catch {
      const current = this.attempts.get(initial.attemptId);
      if (current.result) {
        this.attempts.holdOutput(initial.attemptId, 'Integration output could not be attributed to its exact attempt.', fence);
      } else {
        const dispatched = operationId !== null && this.resources.get(operationId).status !== 'planned';
        this.resources.interruptPreparation(initial.attemptId);
        const uncertain = dispatched || this.attempts.store.read(db => !!db.query(
          "SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('unknown','abandoned') LIMIT 1").get(initial.attemptId));
        this.attempts.observe(initial.attemptId, { ...integrationObservation(uncertain ? 'unknown' : 'not-started',
          uncertain ? 'Integration or preparation may have executed; retained without replay.' : 'Integration preparation was not dispatched.'),
          admissionFailure: !fence.shutdown.aborted }, fence);
      }
    } finally {
      try { this.attempts.releaseControl(initial.attemptId, fence); }
      finally { this.#active.delete(initial.attemptId); }
    }
  }

  async stop(attempt: WorkflowAttempt, kind: WorkflowRevocationKind = 'intervention'): Promise<void> {
    const active = this.#active.get(attempt.attemptId);
    if (active) {
      if (active.kind !== 'intervention') active.kind = kind;
      active.observation.abort();
    }
    this.attempts.revoke(attempt.attemptId, 'Workflow integration control was revoked.', kind);
  }
}

function integrationObservation(resolution: WorkflowTerminalObservation['resolution'], detail: string): WorkflowTerminalObservation {
  const certainty = resolution === 'not-started' || resolution === 'unknown' ? resolution : 'definite';
  return { resolution, result: { certainty, detail: detail.slice(0, 4096), executionScope: null, commandOutcome: null,
    termination: certainty === 'definite' ? 'observed' : certainty, receivedOutputCoverage: 'unknown', outputCaptured: false } };
}

function boundedIntegrationResult(result: Exclude<WorkflowIntegrationResult, { kind: 'not-started' | 'unknown' }>) {
  const identity = { executorId: result.executorId, instanceId: result.instanceId, managed: result.managed };
  if (result.kind === 'integrated') return { ...identity, kind: result.kind };
  let bytes = 0;
  const paths: string[] = [];
  for (const path of result.paths) {
    const size = Buffer.byteLength(JSON.stringify(path));
    if (paths.length >= 64 || bytes + size > 8192) break;
    paths.push(path); bytes += size;
  }
  return { ...identity, kind: result.kind, paths, pathCount: result.paths.length, pathsTruncated: paths.length !== result.paths.length };
}
