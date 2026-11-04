import { setImmediate } from 'node:timers/promises';
import { WORKFLOW_LIMITS, type WorkflowAttempt, type WorkflowRevocationKind } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import { createLogger } from '../../common/log.js';
import { readWorkflowCapacity, WorkflowAttempts } from './attempts.js';
import type { WorkflowDispatchPort, WorkflowEffectFence } from './contracts.js';
import { listActiveWorkflowIds, readWorkflowSchedule } from './records.js';
import type { WorkflowStore } from './store.js';

const logger = createLogger('workflows:reconciler');

export class WorkflowReconciler {
  readonly #pending = new Set<string>();
  readonly #running = new Map<string, { attempt: WorkflowAttempt; task: Promise<void>;
    revocation: AbortController; kind: WorkflowRevocationKind | null }>();
  readonly #stops = new Map<string, Promise<void>>();
  readonly #shutdown = new AbortController();
  #admitting = false;
  #failed = false;
  #scan = false;
  #pass: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #visited = 0;

  constructor(private readonly store: WorkflowStore, private readonly attempts: WorkflowAttempts,
    private readonly port: WorkflowDispatchPort, private readonly options: {
      readonly now: () => string;
      readonly onFailure: (error: unknown) => void;
      readonly yield?: () => Promise<void>;
    }) {}

  start(): void {
    if (this.#admitting || this.#failed || this.#shutdown.signal.aborted) return;
    this.#admitting = true;
    this.#timer = setInterval(() => this.wake(), 30_000);
    this.#timer.unref();
    this.wake();
  }

  pauseAdmission(): void {
    this.#admitting = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#pending.clear();
    this.#scan = false;
  }

  wake(workflowId?: string): void {
    if (!this.#admitting || this.#failed) return;
    if (!workflowId || this.#pending.size >= WORKFLOW_LIMITS.tasks) this.#scan = true;
    else this.#pending.add(workflowId);
    if (this.#pass) return;
    this.#pass = Promise.resolve().then(() => this.#reconcile()).catch(error => this.#fail(error)).finally(() => {
      this.#pass = null;
      if (this.#pending.size || this.#scan) this.wake();
    });
  }

  revoke(workflowId: string): void {
    for (const { attempt } of this.#running.values()) {
      if (attempt.workflowId === workflowId) this.revokeAttempt(attempt.attemptId);
    }
    this.wake(workflowId);
  }

  revokeAttempt(attemptId: string, kind: WorkflowRevocationKind = 'intervention'): void {
    const running = this.#running.get(attemptId);
    if (!running) return;
    if (running.kind !== 'intervention') running.kind = kind;
    running.revocation.abort();
    this.wake(running.attempt.workflowId);
  }

  refreshControl(workflowId: string): void {
    for (const { attempt } of this.#running.values()) {
      if (attempt.workflowId !== workflowId) continue;
      const current = this.attempts.get(attempt.attemptId);
      if (current.controlState === 'revoked') {
        const kind = current.revocationKind ?? 'intervention';
        this.revokeAttempt(attempt.attemptId, kind);
        this.#requestStop(attempt, kind);
      }
    }
  }

  stopRunning(workflowId: string): void {
    this.revoke(workflowId);
    for (const { attempt } of this.#running.values()) {
      if (attempt.workflowId === workflowId) this.#requestStop(attempt, 'intervention');
    }
  }

  #requestStop(attempt: WorkflowAttempt, kind: WorkflowRevocationKind): void {
    if (this.#stops.has(attempt.attemptId)) return;
    const stop = Promise.resolve().then(() => this.port.stop(this.attempts.get(attempt.attemptId), kind))
      .catch(error => this.#fail(error)).finally(() => this.#stops.delete(attempt.attemptId));
    this.#stops.set(attempt.attemptId, stop);
  }

  beginShutdown(): void {
    this.pauseAdmission();
    this.#shutdown.abort(new Error('Workflow controller is shutting down.'));
  }

  async flush(): Promise<void> { while (this.#pass) await this.#pass; }
  async waitForSettlements(): Promise<void> {
    await this.flush();
    await Promise.all([...this.#running.values()].map(item => item.task).concat([...this.#stops.values()]));
  }

  async #reconcile(): Promise<void> {
    while (this.#admitting && (this.#scan || this.#pending.size)) {
      if (this.#scan) {
        this.#scan = false;
        let after: string | null = null;
        for (;;) {
          if (!this.#admitting) return;
          const page = this.store.read(db => listActiveWorkflowIds(db, after, 32));
          for (const id of page) {
            this.#pending.delete(id);
            await this.#admitWorkflow(id);
          }
          if (page.length < 32) break;
          after = page.at(-1)!;
          await this.#yield();
        }
      } else {
        const ids = [...this.#pending].slice(0, 32);
        for (const id of ids) {
          this.#pending.delete(id);
          await this.#admitWorkflow(id);
        }
      }
      await this.#yield();
    }
  }

  async #admitWorkflow(workflowId: string): Promise<void> {
    if (!this.#admitting || this.#running.size >= WORKFLOW_LIMITS.globalAttempts) return;
    const detail = this.store.read(db => readWorkflowSchedule(db, workflowId));
    if (!detail.active || detail.workflow.desired !== 'active' || detail.workflow.archived) return;
    let capacity = this.store.read(readWorkflowCapacity);
    const workflowLimit = Math.min(WORKFLOW_LIMITS.workflowAttempts, detail.active.plan.policy.concurrency);
    for (const task of detail.tasks) {
      if (!this.#admitting || this.#running.size >= WORKFLOW_LIMITS.globalAttempts) return;
      if (this.#visited === 32) {
        await this.#yield(); if (!this.#admitting) return;
        capacity = this.store.read(readWorkflowCapacity);
      }
      if (capacity.length >= WORKFLOW_LIMITS.globalAttempts
        || capacity.filter(row => row.workflowId === workflowId).length >= workflowLimit) return;
      this.#visited++;
      if (task.phase !== 'ready' || task.nextEligibleAt && task.nextEligibleAt > this.options.now()) continue;
      const spec = detail.active.plan.tasks.find(candidate => candidate.id === task.id)!;
      if (spec.spec.kind === 'approval') continue;
      const executorId = spec.spec.target.executorId;
      if (capacity.filter(row => row.executorId === executorId).length >= WORKFLOW_LIMITS.executorAttempts) continue;
      if ([...this.#running.values()].some(({ attempt }) => attempt.workflowId === workflowId && attempt.taskId === task.id)) continue;
      if (!this.port.available(spec)) continue;
      try {
        const attempt = this.attempts.reserve(workflowId, task.id);
        if (attempt) {
          capacity.push({ workflowId, executorId: attempt.target!.executorId });
          this.#dispatch(attempt);
        }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WORKFLOW_CONFLICT') throw error;
        this.attempts.holdAdmission(workflowId, task.id, error.message);
      }
    }
  }

  #dispatch(attempt: WorkflowAttempt): void {
    const control = { revocation: new AbortController(), kind: null as WorkflowRevocationKind | null };
    const owner = this;
    const fence: WorkflowEffectFence = {
      get revoked() { return control.revocation.signal.aborted || owner.#failed; },
      get reason() { return this.revoked ? 'Workflow effects were revoked.' : null; },
      get revocationKind() { return control.kind; },
      revokedSignal: control.revocation.signal,
      shutdown: this.#shutdown.signal,
    };
    const task = Promise.resolve().then(() => this.port.dispatch(attempt, fence)).catch(error => {
      this.#fail(error);
      try {
        this.attempts.revoke(attempt.attemptId, 'Unclassified workflow dispatch failure.');
        this.attempts.observe(attempt.attemptId, { resolution: 'unknown', result: {
          certainty: 'unknown', detail: 'Workflow dispatch failed without a definitive observation.',
          commandOutcome: null, receivedOutputCoverage: 'unknown', outputCaptured: false, termination: 'unknown',
        } }, { revoked: true, reason: 'Unclassified workflow dispatch failure.' });
      } catch (failure) { logger.warn('Unsettled attempt retained for restart recovery.', { failure }); }
    }).finally(() => {
      this.#running.delete(attempt.attemptId);
      this.wake();
    });
    this.#running.set(attempt.attemptId, Object.assign(control, { attempt, task }));
  }

  #yield(): Promise<void> { this.#visited = 0; return this.options.yield?.() ?? setImmediate(); }

  #fail(error: unknown): void {
    this.#failed = true;
    this.pauseAdmission();
    try { this.options.onFailure(error); }
    catch (failure) { logger.warn('Workflow failure notification could not be delivered.', { failure }); }
  }
}
