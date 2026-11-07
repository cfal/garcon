import { setTimeout as delay } from 'node:timers/promises';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import { matchesPublication } from '../../../common/gh-identity.js';
import type { GhPublishedPullRequest } from '../../../common/gh.js';
import type { WorkflowAttempt, WorkflowRevocationKind } from '../../../common/workflows.js';
import { WorkflowAttempts, requireWorkflowInputs, type WorkflowTerminalObservation } from './attempts.js';
import type { WorkflowEffectFence, WorkflowEvidenceRepositoryPort, WorkflowRepositoryPort } from './contracts.js';
import { WorkflowEvidenceSettlement } from './evidence-settlement.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { matchesManagedTarget } from './managed-target.js';
import type { WorkflowPublication, WorkflowPublicationPort } from './publication-contracts.js';
import { publicationIntentPayload, requirePublicationApproval, requirePublicationOperation } from './publication-manifest.js';
import { readPlan } from './records.js';
import { WorkflowResources } from './resources.js';

export class WorkflowPublicationAdmission {
  readonly #active = new Map<string, { kind: WorkflowRevocationKind | null; reads: AbortController }>();
  readonly #settlement: WorkflowEvidenceSettlement;

  constructor(private readonly attempts: WorkflowAttempts, private readonly resources: WorkflowResources,
    private readonly repositories: WorkflowRepositoryPort & WorkflowEvidenceRepositoryPort, private readonly publication: WorkflowPublicationPort,
    private readonly options: { readonly now: () => string; readonly onInvalidated?: (workflowId: string, revision: number) => void;
      readonly wait?: (ms: number, signal: AbortSignal) => Promise<void> }) {
    this.#settlement = new WorkflowEvidenceSettlement(attempts.store, options);
  }

  async dispatch(initial: WorkflowAttempt, effect: WorkflowEffectFence): Promise<void> {
    if (this.#active.has(initial.attemptId)) workflowConflict('Publication admission is already owned.');
    const active = { kind: null as WorkflowRevocationKind | null, reads: new AbortController() };
    this.#active.set(initial.attemptId, active);
    const fence: WorkflowEffectFence = {
      get revoked() { return active.kind !== null || effect.revoked; },
      get reason() { return active.kind ? 'Publication control was revoked.' : effect.reason; },
      get revocationKind() { return active.kind === 'intervention' || effect.revocationKind === 'intervention'
        ? 'intervention' : active.kind ?? effect.revocationKind; },
      revokedSignal: AbortSignal.any([active.reads.signal, effect.revokedSignal]), shutdown: effect.shutdown,
    };
    const signal = AbortSignal.any([fence.shutdown, fence.revokedSignal]);
    try {
      let attempt = this.attempts.beginPreparation(initial.attemptId);
      const task = this.attempts.store.read(db => readPlan(db, attempt.workflowId, attempt.planRevision)).plan.tasks.find(task => task.id === attempt.taskId)!;
      if (task.spec.kind !== 'publish-pr') workflowConflict('This task does not admit publication.');
      const prepared = await this.repositories.prepare(attempt, task, fence);
      if (prepared.kind !== 'prepared') {
        this.resources.interruptPreparation(attempt.attemptId);
        this.attempts.observe(attempt.attemptId, observation(prepared.kind === 'held' ? 'not-started' : prepared.kind,
          prepared.detail, prepared.kind === 'held'), fence);
        return;
      }
      attempt = this.attempts.bindTarget(attempt.attemptId, prepared.resource);
      const approved = this.attempts.store.read(db => requirePublicationApproval(db, attempt));
      const pushId = crypto.randomUUID();
      const createId = approved.publication.operationId;
      for (const [id, stage] of [[pushId, 'push'], [createId, 'create']] as const) {
        const payload = this.attempts.store.read(db => publicationIntentPayload(db, attempt, stage));
        this.resources.plan({ operationId: id, attemptId: attempt.attemptId, kind: 'publication', payload,
          resourceKey: workflowDigest(stage === 'push'
            ? { remoteUrl: approved.publication.remoteUrl, ref: `refs/heads/${approved.publication.headBranch}` }
            : { repository: approved.publication.repository, marker: createId }) });
      }
      const call = await this.publication.prepare(approved.publication, prepared.resource, fence.shutdown);
      await call.verify(signal);
      this.attempts.markPublicationDispatching(attempt.attemptId, pushId, createId, fence);
      const pushed = await call.push();
      this.resources.observe(pushId, pushed.kind === 'observed' ? 'succeeded' : pushed.kind, JSON.stringify(pushed));
      if (pushed.kind !== 'observed') {
        this.resources.interruptPreparation(attempt.attemptId);
        this.attempts.observe(attempt.attemptId, observation(pushed.kind, pushed.detail, pushed.kind === 'not-started'), fence);
        return;
      }
      await call.verify(signal);
      this.resources.begin(createId, fence);
      const created = await call.create();
      this.resources.observe(createId, created.kind === 'observed' ? 'succeeded' : created.kind, JSON.stringify(created));
      const pull = created.kind === 'observed' ? created.value : created.kind === 'unknown'
        ? await this.#reconcile(createId, approved.publication, signal) : null;
      if (!pull) {
        const kind = created.kind === 'not-started' ? 'not-started' : 'unknown';
        this.attempts.observe(attempt.attemptId, observation(kind, 'Publication not confirmed; retained ref and intent require operator attention.', kind === 'not-started'), fence);
        return;
      }
      if (!matchesPublication(pull, approved.publication)) throw new Error('Publication result differs from the approved manifest.');
      this.attempts.store.transaction(db => {
        requireWorkflowInputs(db, this.attempts.get(attempt.attemptId));
        if (fence.revoked || signal.aborted) workflowConflict('Publication attribution was revoked.');
        if (!db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('planned','dispatching','unknown','abandoned')")
          .get(attempt.attemptId)) db.query('UPDATE resource_claims SET quarantined=0 WHERE attempt_id=? AND risk_released=0').run(attempt.attemptId);
      });
      attempt = this.attempts.observe(attempt.attemptId, observation('checking', 'Exact approved pull request observed open.'), fence);
      if (attempt.resolution !== 'open') return;
      const observed = await this.repositories.inspect(prepared.resource,
        AbortSignal.any([signal, AbortSignal.timeout(3 * GIT_OPERATION_TIMEOUT_MS)]));
      this.#settlement.commit(attempt, task, fence, signal, (db, current) => {
        const operation = requirePublicationOperation(db, current, createId, 'create');
        const resource = current.managedTarget!;
        const pass = operation.status === 'succeeded' && matchesManagedTarget(resource, observed.managed) && !observed.managed.dirty
          && observed.executorId === resource.target.executorId && observed.instanceId === resource.instanceId
          && observed.managed.head === approved.publication.headCommit && observed.commit.commit === resource.head
          && observed.commit.containsAncestor === true;
        return [{ kind: 'pull-request', provenance: 'runtime-observed', outcome: pass ? 'pass' : 'unknown',
          summary: pass ? 'Approved pull request observed open at the exact head.' : 'Publication repository changed during verification.',
          executorId: resource.target.executorId, repositoryId: resource.target.repositoryId, commit: pull.headCommit,
          dirty: observed.managed.dirty, url: pull.url, commandOutcome: null, receivedOutputCoverage: 'unknown', observedAt: this.options.now(),
          git: { scope: 'managed-publication', operationId: createId, manifestDigest: approved.digest,
            runtimeInstanceId: resource.instanceId, repositoryIdentity: resource.repositoryIdentity, worktreeIdentity: resource.worktreeIdentity,
            projectPath: resource.target.projectPath, inputCommit: resource.head, inputTree: resource.baseTree,
            outputTree: observed.commit.tree, containsInput: observed.commit.containsAncestor } }];
      });
    } catch {
      const attempt = this.attempts.get(initial.attemptId);
      if (attempt.result) this.attempts.holdOutput(attempt.attemptId, 'Publication output attribution could not be confirmed.', fence);
      else {
        this.resources.interruptPreparation(attempt.attemptId);
        const uncertain = this.attempts.store.read(db => !!db.query(`SELECT 1 FROM operation_intents WHERE attempt_id=?
          AND (status IN ('unknown','abandoned') OR kind='publication' AND status='succeeded' AND json_extract(payload_json,'$.stage')='create')`)
          .get(attempt.attemptId));
        this.attempts.observe(attempt.attemptId, observation(uncertain ? 'unknown' : 'not-started',
          uncertain ? 'Publication may have executed; no effect will be repeated.' : 'Publication preparation changed; review the retained resources.', !uncertain), fence);
      }
    } finally {
      try { this.attempts.releaseControl(initial.attemptId, fence); }
      finally { this.#active.delete(initial.attemptId); }
    }
  }

  async #reconcile(id: string, publication: WorkflowPublication, signal: AbortSignal): Promise<GhPublishedPullRequest | null> {
    for (let index = 0; index < 5; index++) {
      const waitMs = index === 0 ? 0 : Math.min(300_000, 1000 * 2 ** (index - 1));
      this.attempts.store.transaction(db => db.query('UPDATE operation_intents SET reconcile_count=reconcile_count+1,next_reconcile_at=? WHERE id=?')
        .run(new Date(Date.parse(this.options.now()) + waitMs).toISOString(), id));
      if (waitMs) await (this.options.wait?.(waitMs, signal) ?? delay(waitMs, undefined, { signal }));
      signal.throwIfAborted();
      try {
        const found = await this.publication.find(publication, signal);
        if (found.executorId !== publication.executorId || found.instanceId !== publication.runtimeInstanceId
          || found.actor.id !== publication.actor.id || workflowDigest(found.repository) !== workflowDigest(publication.repository)) return null;
        if (found.pulls.length > 1 || found.pulls.length === 1 && !matchesPublication(found.pulls[0]!, publication)) return null;
        if (found.pulls.length === 1) {
          this.resources.observe(id, 'succeeded', JSON.stringify({ kind: 'observed', value: found.pulls[0], reconciled: true }));
          return found.pulls[0]!;
        }
      } catch { if (signal.aborted) return null; }
    }
    return null;
  }

  async stop(attempt: WorkflowAttempt, kind: WorkflowRevocationKind = 'intervention'): Promise<void> {
    const active = this.#active.get(attempt.attemptId);
    if (active) { if (active.kind !== 'intervention') active.kind = kind; active.reads.abort(); }
    this.attempts.revoke(attempt.attemptId, 'Publication control was revoked.', kind);
  }
}

function observation(resolution: WorkflowTerminalObservation['resolution'], detail: string, hold = false): WorkflowTerminalObservation {
  const certainty = resolution === 'not-started' || resolution === 'unknown' ? resolution : 'definite';
  return { resolution, ...(hold ? { admissionHold: detail } : {}), result: { certainty, detail, commandOutcome: null,
    executionScope: null, termination: certainty === 'definite' ? 'observed' : certainty, outputCaptured: false, receivedOutputCoverage: 'unknown' } };
}
