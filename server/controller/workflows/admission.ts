import type { AutomationResult, AutomationTurnKey } from '../../../common/automation.js';
import type { WorkflowAttempt, WorkflowPlanTask, WorkflowRevocationKind } from '../../../common/workflows.js';
import { waitAbortably } from '../../common/abortable-wait.js';
import { WorkflowAttempts, type WorkflowTerminalObservation } from './attempts.js';
import type { WorkflowChatPort, WorkflowEffectFence, WorkflowOutputFence, WorkflowOutputPort,
  WorkflowPreparedTurn, WorkflowRepositoryPort } from './contracts.js';
import { workflowConflict } from './errors.js';
import { workflowStartInput } from './inputs.js';
import { readPlan } from './records.js';
import { WorkflowResources } from './resources.js';
import { workflowResultDetail, workflowTerminalObservation } from './terminal-observation.js';

interface Admission {
  turn: WorkflowPreparedTurn | null;
  stopped: WorkflowRevocationKind | null;
  stop: Promise<void> | null;
  released: boolean;
  readonly observation: AbortController;
}

export class WorkflowChatAdmission {
  readonly #admissions = new Map<string, Admission>();
  readonly #stops = new Set<Promise<void>>();
  #failed = false;

  constructor(private readonly attempts: WorkflowAttempts, private readonly chats: WorkflowChatPort,
    private readonly repositories: WorkflowRepositoryPort, private readonly output: WorkflowOutputPort,
    private readonly options: { readonly onRevoked: (attemptId: string) => void;
      readonly observationTimeoutMs?: number;
      readonly onFailure: (error: unknown) => void }) {}

  async dispatch(initial: WorkflowAttempt, effect: WorkflowEffectFence): Promise<void> {
    if (this.#admissions.has(initial.attemptId)) workflowConflict('Attempt admission is already owned.');
    const admission: Admission = { turn: null, stopped: null, stop: null, released: false, observation: new AbortController() };
    this.#admissions.set(initial.attemptId, admission);
    const observer = new AbortController();
    let terminal: Promise<AutomationResult> | null = null;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const revoked = () => {
      try { this.options.onRevoked(initial.attemptId); }
      catch (error) { this.#fail(error); }
    };
    const owner = this;
    const fence: WorkflowOutputFence = {
      get revoked() { return owner.#failed || admission.stopped !== null || effect.revoked || !!admission.turn?.control.revoked.aborted; },
      get reason() { return admission.stopped === 'superseded' ? 'Workflow generation was superseded.' : admission.stopped ? 'Workflow work was stopped.' : effect.reason
        ?? (admission.turn?.control.revoked.aborted ? 'Worker control was taken over.' : null); },
      get revocationKind() { return admission.stopped === 'intervention' || admission.turn?.control.revoked.aborted || effect.revocationKind === 'intervention'
        ? 'intervention' : admission.stopped ?? effect.revocationKind; },
      revokedSignal: AbortSignal.any([admission.observation.signal, effect.revokedSignal]),
      get outputGapped() { return !!admission.turn?.control.outputGapped.aborted; },
      shutdown: effect.shutdown,
    };
    try {
      assertAdmissionOpen(fence);
      let attempt = this.attempts.beginPreparation(initial.attemptId);
      const task = this.attempts.store.read(db => readPlan(db, attempt.workflowId, attempt.planRevision))
        .plan.tasks.find(task => task.id === attempt.taskId)!;
      if (task.spec.kind !== 'agent' && task.spec.kind !== 'command') workflowConflict('This task does not admit a chat.');
      const repository = await this.repositories.prepare(attempt, task, fence);
      if (repository.kind !== 'prepared') {
        new WorkflowResources(this.attempts.store, () => new Date().toISOString()).interruptPreparation(attempt.attemptId);
        this.attempts.observe(attempt.attemptId, repository.kind === 'held'
          ? { ...admissionObservation('not-started', repository.detail), admissionHold: repository.detail }
          : admissionObservation(repository.kind, repository.detail), fence);
        return;
      }
      assertAdmissionOpen(fence);
      attempt = this.attempts.bindTarget(attempt.attemptId, repository.resource);
      const prepared = await this.chats.prepare(workflowStartInput(attempt, task));
      if (prepared.kind !== 'prepared') {
        this.attempts.observe(attempt.attemptId, admissionObservation('not-started', prepared.code), fence);
        return;
      }
      admission.turn = prepared.turn;
      admission.turn.control.revoked.addEventListener('abort', revoked, { once: true });
      if (admission.turn.control.revoked.aborted) revoked();
      assertAdmissionOpen(fence);
      attempt = this.attempts.bindPrepared(attempt.attemptId, admission.turn.key, admission.turn.effectiveInput);
      // Installs rejection handling immediately and persists observed terminals without waiting for start().
      terminal = this.chats.waitForTerminal(admission.turn.key, AbortSignal.any([observer.signal, fence.shutdown]))
        .catch((): AutomationResult => ({ kind: 'unavailable', reason: 'Terminal observation ended without a result.',
          commandOutcome: null, receivedOutputCoverage: 'unknown', executionScope: null }))
        .then(result => {
          if (result.kind !== 'unavailable') {
            if (timer) clearTimeout(timer);
            timer = null;
            this.#observe(attempt.attemptId, task, result, fence);
          }
          return result;
        });
      void terminal.catch(() => {});
      this.attempts.markDispatching(attempt.attemptId, fence);
      assertAdmissionOpen(fence);
      started = true;
      if (task.spec.kind === 'command') {
        timer = setTimeout(() => { void this.stop(attempt).catch(error => this.#fail(error)); }, task.spec.timeoutMs);
        timer.unref();
      }
      const start = await admission.turn.start();
      if (start.kind !== 'published') {
        this.attempts.observe(attempt.attemptId, admissionObservation(start.kind,
          start.kind === 'unknown' ? start.reason : `${start.code}; inputPublished=${start.inputPublished}`), fence);
        if (this.attempts.get(attempt.attemptId).resolution === 'open') {
          this.attempts.holdOutput(attempt.attemptId, 'Start did not confirm publication after a terminal observation.', fence, fence.outputGapped);
        }
        return;
      }
      const result = await terminal;
      if (timer) clearTimeout(timer);
      timer = null;
      if (result.kind === 'unavailable') this.#observe(attempt.attemptId, task, result, fence);
      const observed = this.attempts.get(attempt.attemptId);
      if (observed.resolution !== 'open') return;
      await this.#capture(observed, task, result, fence);
    } catch (error) {
      if (!started) {
        await admission.turn?.cancel();
        new WorkflowResources(this.attempts.store, () => new Date().toISOString()).interruptPreparation(initial.attemptId);
        this.attempts.observe(initial.attemptId, { ...admissionObservation('not-started', errorText(error)),
          admissionFailure: !fence.shutdown.aborted }, fence);
      } else {
        const attempt = this.attempts.get(initial.attemptId);
        if (attempt.result) this.attempts.holdOutput(initial.attemptId, errorText(error), fence, fence.outputGapped);
        else this.attempts.observe(initial.attemptId, admissionObservation('unknown', errorText(error)), fence);
      }
    } finally {
      if (timer) clearTimeout(timer);
      observer.abort();
      if (terminal) await terminal.catch(() => {});
      admission.turn?.control.revoked.removeEventListener('abort', revoked);
      try {
        if (!admission.released) this.attempts.releaseControl(initial.attemptId, fence);
      } finally {
        if (!admission.released) admission.turn?.control.release();
        this.#admissions.delete(initial.attemptId);
      }
    }
  }

  stop(attempt: WorkflowAttempt, kind: WorkflowRevocationKind = 'intervention'): Promise<void> {
    const admission = this.#admissions.get(attempt.attemptId);
    if (admission) {
      if (admission.stopped !== 'intervention') admission.stopped = kind;
      admission.observation.abort();
    }
    if (admission?.stop) return admission.stop;
    const stopping = this.#stop(attempt, admission, kind).finally(() => this.#stops.delete(stopping));
    this.#stops.add(stopping);
    if (admission) admission.stop = stopping;
    return stopping;
  }

  async waitForStops(): Promise<void> { await Promise.allSettled([...this.#stops]); }

  async #stop(attempt: WorkflowAttempt, admission: Admission | undefined, kind: WorkflowRevocationKind): Promise<void> {
    try { this.attempts.revoke(attempt.attemptId, kind === 'superseded' ? 'Workflow generation was superseded.' : 'Workflow work was stopped.', kind); }
    finally {
      if (admission?.turn) await admission.turn.cancel();
      else if (attempt.chatId && attempt.turnId && attempt.serverInstanceId) await this.chats.stop(turnKey(attempt));
    }
  }

  #fail(error: unknown): void {
    this.#failed = true;
    try { this.options.onFailure(error); }
    catch (failure) { console.error('Workflow admission failure notification failed', failure); }
  }

  #observe(attemptId: string, task: WorkflowPlanTask, result: AutomationResult, fence: WorkflowOutputFence): void {
    const terminal = fence.outputGapped ? { ...result, receivedOutputCoverage: 'gapped' as const } : result;
    const observation = fence.shutdown.aborted
      ? admissionObservation('unknown', 'Controller shutdown interrupted terminal observation.')
      : workflowTerminalObservation(task, terminal);
    this.attempts.observe(attemptId, { ...observation, retainControl: true }, fence);
  }

  async #capture(attempt: WorkflowAttempt, task: WorkflowPlanTask, result: AutomationResult, fence: WorkflowOutputFence): Promise<void> {
    const observation = new AbortController();
    const timer = setTimeout(() => observation.abort(new Error('Worker output observation timed out.')),
      Math.min(this.options.observationTimeoutMs ?? 30_000, 30_000));
    timer.unref();
    const signal = AbortSignal.any([fence.shutdown, fence.revokedSignal, observation.signal,
      this.#admissions.get(attempt.attemptId)!.turn!.control.revoked]);
    try {
      assertAdmissionOpen(fence);
      await waitAbortably(this.chats.waitForOwnershipRelease(attempt.chatId!, signal), signal);
      assertAdmissionOpen(fence);
      signal.throwIfAborted();
      const chat = await waitAbortably(this.chats.inspect(attempt.chatId!, signal), signal);
      assertAdmissionOpen(fence);
      if (!chat.exists || chat.ownsExecution || chat.pendingInput) {
        this.attempts.holdOutput(attempt.attemptId, 'Worker is unavailable or has pending work.',
          { revoked: true, reason: 'Worker observation window changed.' }, fence.outputGapped);
        return;
      }
      signal.throwIfAborted();
      const evidence = await waitAbortably(this.output.capture(attempt, task, result, fence, signal), signal);
      assertAdmissionOpen(fence);
      signal.throwIfAborted();
      const finalChat = await waitAbortably(this.chats.inspect(attempt.chatId!, signal), signal);
      assertAdmissionOpen(fence);
      if (!finalChat.exists || finalChat.ownsExecution || finalChat.pendingInput) {
        this.attempts.holdOutput(attempt.attemptId, 'Worker observation window changed before acceptance.',
          { revoked: true, reason: 'Worker observation window changed.' }, fence.outputGapped);
        return;
      }
      signal.throwIfAborted();
      evidence.commit();
      if (this.attempts.get(attempt.attemptId).resolution === 'open') {
        this.attempts.holdOutput(attempt.attemptId, 'Required output evidence was not committed.', fence, fence.outputGapped);
      }
      // Acceptance is the attribution boundary; later actor changes cannot revoke committed evidence.
      this.attempts.releaseControl(attempt.attemptId, { revoked: false, reason: null });
      const admission = this.#admissions.get(attempt.attemptId)!;
      admission.released = true;
      admission.turn!.control.release();
    } finally { clearTimeout(timer); }
  }
}

function assertAdmissionOpen(fence: WorkflowEffectFence): void {
  fence.shutdown.throwIfAborted();
  if (fence.revoked) workflowConflict(fence.reason ?? 'Workflow effects were revoked.');
}

function admissionObservation(kind: 'not-started' | 'unknown', detail: string): WorkflowTerminalObservation {
  return { resolution: kind, result: { certainty: kind, detail: workflowResultDetail(detail),
    termination: kind === 'not-started' ? 'not-started' : 'unknown', commandOutcome: null,
    receivedOutputCoverage: 'unknown', outputCaptured: false, executionScope: null } };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Workflow admission failed.'; }

function turnKey(attempt: WorkflowAttempt): AutomationTurnKey {
  return { serverInstanceId: attempt.serverInstanceId!, chatId: attempt.chatId!, turnId: attempt.turnId!, clientRequestId: attempt.requestId };
}
