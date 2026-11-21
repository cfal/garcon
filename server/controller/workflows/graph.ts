import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { WORKFLOW_TURN_COMPLETED, type WorkflowSignalReference, type WorkflowStep } from '../../../common/workflow-definition.js';
import type { JsonObject, JsonValue } from '../../../common/json.js';
import type {
  WorkflowInstanceStatus, WorkflowLocation, WorkflowRunStatus, WorkflowSignalSource, WorkflowStepSettings, WorkflowTrigger,
} from '../../../common/workflow-runs.js';
import { workflowProducerCanEmit } from '../../../common/workflow-runs.js';
import { bindPrompt, WorkflowBindingError } from './bindings.js';
import { workflowConflict, workflowLimit } from './errors.js';
import { WORKFLOW_LIMITS } from './limits.js';
import { requireRun, runSteps, type RunStepRow, type SignalRow } from './records.js';

export type CapturedStep = {
  readonly step: WorkflowStep;
  readonly location: WorkflowLocation | null;
  readonly settings: WorkflowStepSettings | null;
};

interface StepState {
  readonly id: string;
  readonly step: WorkflowStep;
  readonly added: boolean;
  intake: RunStepRow['intake'];
  reason: string | null;
  closeSequence: number | null;
  counts: Partial<Record<WorkflowInstanceStatus, number>>;
}

interface SignalInput {
  readonly ref: WorkflowSignalReference;
  readonly instanceId: string | null;
  readonly scope: string;
  readonly key: string;
  readonly payloadJson: string | null;
  readonly source: WorkflowSignalSource;
}

function sameSignal(a: WorkflowSignalReference, b: WorkflowSignalReference): boolean {
  return a.stepId === b.stepId && a.signal === b.signal;
}

function label(ref: WorkflowSignalReference): string {
  return `${ref.stepId}.${ref.signal}`;
}

function count(state: StepState, ...statuses: WorkflowInstanceStatus[]): number {
  return statuses.reduce((sum, status) => sum + (state.counts[status] ?? 0), 0);
}

function manualScope(stepId: string): string {
  return `manual:${stepId}`;
}

// All graph transitions run in the caller's transaction, including signal insertion and newly ready instances.
export class WorkflowGraph {
  readonly #steps: Map<string, StepState>;
  readonly #inputs: JsonObject;
  #stepBytes: number | undefined;
  #signalBytes: number;
  #bindingBytes: number;

  constructor(private readonly db: Database, private readonly runId: string, private readonly now: string) {
    const run = requireRun(db, runId);
    this.#inputs = JSON.parse(run.inputs_json) as JsonObject;
    this.#signalBytes = run.signal_bytes;
    this.#bindingBytes = run.binding_bytes;
    this.#steps = new Map(runSteps(db, runId).map(row => [row.id, {
      id: row.id, step: JSON.parse(row.step_json) as WorkflowStep, added: row.added !== 0,
      intake: row.intake, reason: row.reason, closeSequence: row.close_sequence, counts: {},
    }]));
  }

  insertStep(captured: CapturedStep, added = false, evidence?: SignalRow): void {
    const { step, location, settings } = captured;
    if (this.#steps.has(step.id)) throw workflowConflict(`Step "${step.id}" already exists in this run.`);
    if (this.#steps.size >= WORKFLOW_LIMITS.steps) throw workflowLimit('This run has reached its step limit.');
    if (added && step.on) {
      const ref = step.on.kind === 'all' ? step.on.close : step.on.signal;
      const producer = this.#steps.get(ref.stepId)!;
      const instance = this.db.query<{ status: WorkflowInstanceStatus; attempt_count: number }, [string, string]>(
        'SELECT status, attempt_count FROM workflow_instances WHERE run_id = ? AND step_id = ? LIMIT 1',
      ).get(this.runId, ref.stepId);
      const emittedOnce = step.on.kind !== 'each' && this.db.query(
        'SELECT 1 FROM workflow_signals WHERE run_id = ? AND step_id = ? AND signal = ? LIMIT 1',
      ).get(this.runId, ref.stepId, ref.signal);
      if (emittedOnce || !workflowProducerCanEmit(producer.intake === 'open', instance?.status, instance?.attempt_count)) {
        throw workflowConflict(`The producer can no longer emit ${label(ref)}. Select a stored result instead.`);
      }
    }
    const stepJson = JSON.stringify(step);
    const locationJson = location && JSON.stringify(location);
    const settingsJson = settings && JSON.stringify(settings);
    this.#stepBytes ??= this.db.query<{ bytes: number }, [string]>(`
      SELECT coalesce(sum(length(CAST(step_json AS BLOB))
        + coalesce(length(CAST(location_json AS BLOB)), 0)
        + coalesce(length(CAST(settings_json AS BLOB)), 0)), 0) AS bytes
      FROM workflow_run_steps WHERE run_id = ?
    `).get(this.runId)!.bytes;
    const bytes = Buffer.byteLength(stepJson) + Buffer.byteLength(locationJson ?? '') + Buffer.byteLength(settingsJson ?? '');
    if (this.#stepBytes + bytes > WORKFLOW_LIMITS.stepBytesPerRun) throw workflowLimit('This run has reached its saved step data size limit.');
    this.#stepBytes += bytes;
    const intake = step.on ? 'open' : 'closed';
    const state: StepState = { id: step.id, step, intake, added, reason: null, closeSequence: null, counts: {} };
    this.db.query(`INSERT INTO workflow_run_steps (
      run_id, id, step_json, location_json, settings_json, executor_id, provider_id, max_concurrency, intake, added
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.runId, step.id, stepJson, locationJson, settingsJson,
      location?.executorId ?? null, settings?.kind === 'agent' ? settings.apiProviderId ?? null : null,
      step.on?.kind === 'each' ? step.on.maxConcurrency : 1, intake, added ? 1 : 0,
    );
    this.#steps.set(step.id, state);
    if (!step.on) this.#addInstance(state, evidence, added ? 'reject' : 'block');
  }

  emit(input: SignalInput): { row: SignalRow; inserted: boolean } {
    const receipt = this.#insertSignal(input);
    if (receipt.inserted) this.#deliver(receipt.row);
    return receipt;
  }

  addItem(stepId: string, input: Omit<SignalInput, 'scope' | 'instanceId'>): { row: SignalRow; inserted: boolean } {
    const step = this.#steps.get(stepId)!;
    if (step.intake !== 'open') throw workflowConflict(`Repeat group "${stepId}" is closed to new items.`);
    const existing = this.db.query<{ scope: string }, [string, string, string]>(`
      SELECT s.scope FROM workflow_instances i JOIN workflow_signals s ON s.sequence = i.trigger_sequence
      WHERE i.run_id = ? AND i.step_id = ? AND i.key = ? LIMIT 1
    `).get(this.runId, stepId, input.key);
    const scope = manualScope(stepId);
    if (existing && existing.scope !== scope) throw workflowConflict('This key already names a producer item in the repeat group.');
    const receipt = this.#insertSignal({ ...input, scope, instanceId: null });
    if (receipt.inserted) this.#addInstance(step, receipt.row, 'reject');
    return receipt;
  }

  #insertSignal(input: SignalInput): { row: SignalRow; inserted: boolean } {
    const { ref, scope, key, source } = input;
    let { payloadJson } = input;
    const prior = this.db.query<SignalRow, [string, string, string, string]>(`
      SELECT * FROM workflow_signals WHERE run_id = ? AND scope = ? AND signal = ? AND key = ?
    `).get(this.runId, scope, ref.signal, key);
    if (prior) {
      if (prior.payload_json !== payloadJson) throw workflowConflict('This signal was already accepted with a different payload.');
      return { row: prior, inserted: false };
    }
    if (source.kind === 'attempt' || source.kind === 'manual') {
      const { count } = this.db.query<{ count: number }, [string]>(
        'SELECT count(*) AS count FROM workflow_signals WHERE run_id = ?',
      ).get(this.runId)!;
      if (count >= WORKFLOW_LIMITS.explicitSignals) throw workflowLimit('This run has reached its signal limit.');
    }
    let size = payloadJson === null ? 0 : Buffer.byteLength(payloadJson);
    if (this.#signalBytes + size > WORKFLOW_LIMITS.signalBytesPerRun) {
      if (source.kind !== 'completion') throw workflowLimit('This run has reached its signal payload limit.');
      // Completion-only edges still proceed when the complete final response cannot be stored.
      payloadJson = null;
      size = 0;
      this.db.query('UPDATE workflow_attempts SET reason = ? WHERE id = ?').run('Final output exceeds the run storage limit.', source.attemptId);
    }
    this.#signalBytes += size;
    this.db.query('UPDATE workflow_runs SET signal_bytes = ? WHERE id = ?').run(this.#signalBytes, this.runId);
    const row = this.db.query<SignalRow, (string | null)[]>(`
      INSERT INTO workflow_signals (id, run_id, step_id, instance_id, signal, key, scope, payload_json, source_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(randomUUID(), this.runId, ref.stepId, input.instanceId, ref.signal, key, scope, payloadJson, JSON.stringify(source), this.now)!;
    return { row, inserted: true };
  }

  #deliver(signal: SignalRow): void {
    const ref = { stepId: signal.step_id, signal: signal.signal };
    if (signal.key) {
      const groups = [...this.#steps.values()].filter(state => state.step.on?.kind === 'each' && sameSignal(state.step.on.signal, ref));
      if (groups.length && groups.every(group => group.intake !== 'open')) {
        throw workflowConflict('All repeat groups for this signal are closed to new items.');
      }
    }
    for (const state of this.#steps.values()) {
      if (state.intake !== 'open') continue;
      const on = state.step.on;
      if (!on || on.kind === 'all' || !sameSignal(on.signal, ref)) continue;
      if (on.kind === 'each') {
        if (this.db.query('SELECT 1 FROM workflow_signals WHERE run_id = ? AND scope = ? AND signal = ? AND key = ?')
          .get(this.runId, manualScope(state.id), signal.signal, signal.key)) {
          throw workflowConflict(`Repeat group "${state.id}" already has a manual item with that key.`);
        }
      } else this.#setIntake(state, 'closed', null);
      this.#addInstance(state, signal);
    }

    for (const state of this.#steps.values()) {
      const on = state.step.on;
      if (state.intake !== 'open' || on?.kind !== 'all' || state.closeSequence !== null || !sameSignal(on.close, ref)) continue;
      state.closeSequence = signal.sequence;
      this.db.query('UPDATE workflow_run_steps SET close_sequence = ? WHERE run_id = ? AND id = ?')
        .run(signal.sequence, this.runId, state.id);
      // An appended join may take a snapshot, but cannot close a group owned by the existing graph.
      if (!state.added) {
        for (const id of on.steps) this.#setIntake(this.#steps.get(id)!, 'closed', null);
      }
    }
  }

  #setIntake(state: StepState, intake: StepState['intake'], reason: string | null): boolean {
    if (state.intake === intake && state.reason === reason) return false;
    state.intake = intake;
    state.reason = reason;
    this.db.query('UPDATE workflow_run_steps SET intake = ?, reason = ? WHERE run_id = ? AND id = ?')
      .run(intake, reason, this.runId, state.id);
    return true;
  }

  #addInstance(state: StepState, signal: SignalRow | undefined, onBindingError: 'block' | 'reject' = 'block'): void {
    const step = state.step;
    const repeated = step.on?.kind === 'each';
    if (repeated) {
      const { count } = this.db.query<{ count: number }, [string]>(
        'SELECT count(*) AS count FROM workflow_instances WHERE run_id = ? AND is_repeated = 1',
      ).get(this.runId)!;
      if (count >= WORKFLOW_LIMITS.repeatInstances) throw workflowLimit('This run has reached its repeat item limit.');
    }
    const id = randomUUID();
    let status: WorkflowInstanceStatus = step.kind === 'decision' ? 'awaiting-decision' : 'ready';
    let reason: string | null = null;
    let prompt: string | null = null;
    let bindings: string | null = null;
    if (step.kind !== 'command') {
      try {
        const payload = signal?.payload_json == null ? undefined : JSON.parse(signal.payload_json) as JsonValue;
        const result = bindPrompt(step, this.#inputs, payload, stepId => this.#collectAll(stepId, signal!.sequence));
        if (this.#bindingBytes + result.bytes > WORKFLOW_LIMITS.bindingBytesPerRun) {
          throw new WorkflowBindingError('Run has reached its bound input storage limit.');
        }
        this.#bindingBytes += result.bytes;
        this.db.query('UPDATE workflow_runs SET binding_bytes = ? WHERE id = ?').run(this.#bindingBytes, this.runId);
        prompt = result.prompt;
        bindings = result.bindingsJson;
      } catch (error) {
        if (!(error instanceof WorkflowBindingError)) throw error;
        if (onBindingError === 'reject') throw workflowConflict(error.message);
        status = 'blocked';
        reason = error.message;
      }
    }
    let trigger: WorkflowTrigger = { kind: 'root' };
    if (signal) {
      trigger = step.on?.kind === 'all' ? { kind: 'join', closeSignalId: signal.id } : { kind: 'signal', signalId: signal.id };
    }
    this.db.query(`INSERT INTO workflow_instances (
      id, run_id, step_id, key, trigger_json, trigger_sequence, is_repeated, status, reason, bindings_json, prompt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, this.runId, step.id, repeated ? signal?.key ?? null : null, JSON.stringify(trigger), signal?.sequence ?? null,
      repeated ? 1 : 0, status, reason, bindings, prompt,
    );
    state.counts[status] = (state.counts[status] ?? 0) + 1;
  }

  #collectAll(stepId: string, close: number): JsonValue {
    const members = `FROM workflow_instances i LEFT JOIN workflow_signals s ON s.instance_id = i.id AND s.signal = ?
      WHERE i.run_id = ? AND i.step_id = ? AND i.trigger_sequence <= ?`;
    const args = [WORKFLOW_TURN_COMPLETED, this.runId, stepId, close] as const;
    const totals = this.db.query<{ items: number; complete: number; bytes: number }, [string, string, string, number]>(`
      SELECT count(*) AS items, count(s.payload_json) AS complete,
        coalesce(sum(length(CAST(s.payload_json AS BLOB))), 0) AS bytes ${members}
    `).get(...args)!;
    if (totals.items !== totals.complete) throw new WorkflowBindingError(`Step "${stepId}" has an item without complete final output.`);
    if (totals.bytes + totals.items + 1 > WORKFLOW_LIMITS.promptBytes) {
      throw new WorkflowBindingError(`Step "${stepId}" final outputs exceed the binding size limit.`);
    }
    return this.db.query<{ payload_json: string }, [string, string, string, number]>(
      `SELECT s.payload_json ${members} ORDER BY i.trigger_sequence`,
    ).all(...args).map(row => JSON.parse(row.payload_json) as JsonValue);
  }

  #availability(ref: WorkflowSignalReference): 'pending' | 'attention' | 'absent' | 'unselected' {
    const source = this.#steps.get(ref.stepId)!;
    if (source.intake === 'blocked' || count(source, 'failed', 'unknown', 'blocked')) return 'attention';
    if (source.intake === 'open' || count(source, 'ready', 'running', 'waiting-executor', 'awaiting-decision')) return 'pending';
    if (source.intake === 'skipped' || source.step.kind === 'decision') return 'unselected';
    return 'absent';
  }

  #reconcileStep(state: StepState): boolean {
    const on = state.step.on;
    if (state.intake !== 'open' || !on) return false;
    const reference = on.kind === 'all' ? on.close : on.signal;
    if (on.kind === 'all' && state.closeSequence !== null) {
      const pending = this.db.query<{ total: number; attention: number | null }, [string, string, number]>(`
        SELECT count(*) AS total, sum(status IN ('failed', 'unknown', 'blocked')) AS attention
        FROM workflow_instances WHERE run_id = ? AND step_id IN (SELECT value FROM json_each(?))
          AND trigger_sequence <= ? AND status != 'succeeded'
      `).get(this.runId, JSON.stringify(on.steps), state.closeSequence)!;
      if (pending.total) {
        const reason = pending.attention ? 'Accepted items need attention before the join can start.' : 'Waiting for all accepted items to succeed.';
        return this.#setIntake(state, 'open', reason);
      }
      const close = this.db.query<SignalRow, [number]>('SELECT * FROM workflow_signals WHERE sequence = ?').get(state.closeSequence)!;
      this.#setIntake(state, 'closed', null);
      this.#addInstance(state, close);
      return true;
    }

    const availability = this.#availability(reference);
    if (on.kind === 'each') {
      const closer = [...this.#steps.values()].find(candidate => !candidate.added && candidate.intake === 'open'
        && candidate.step.on?.kind === 'all' && candidate.step.on.steps.includes(state.id));
      if (closer?.step.on?.kind === 'all' && availability !== 'pending') {
        return this.#setIntake(state, 'open', `Waiting for ${label(closer.step.on.close)} to close intake.`);
      }
      if (availability === 'absent' || availability === 'unselected') return this.#setIntake(state, 'closed', null);
    } else if (availability === 'absent' || availability === 'unselected') {
      return this.#setIntake(state, on.kind === 'all' && availability === 'absent' ? 'blocked' : 'skipped',
        `Signal ${label(reference)} was not emitted.`);
    }
    return this.#setIntake(state, 'open', availability === 'attention'
      ? `Waiting for ${label(reference)}; its producer needs attention.`
      : `Waiting for ${label(reference)}.`);
  }

  reconcile(): void {
    for (const step of this.#steps.values()) step.counts = {};
    const counts = this.db.query<{ step_id: string; status: WorkflowInstanceStatus; total: number }, [string]>(
      'SELECT step_id, status, count(*) AS total FROM workflow_instances WHERE run_id = ? GROUP BY step_id, status',
    ).all(this.runId);
    for (const item of counts) this.#steps.get(item.step_id)!.counts[item.status] = item.total;
    // Closing or skipping a producer can make another listener unreachable, regardless of authored order.
    for (let pass = 0; pass <= this.#steps.size; pass++) {
      let changed = false;
      for (const state of this.#steps.values()) changed = this.#reconcileStep(state) || changed;
      if (!changed) break;
    }
    let status: WorkflowRunStatus = 'succeeded';
    for (const state of this.#steps.values()) {
      if (count(state, 'ready', 'running')) { status = 'running'; break; }
      if (state.intake === 'blocked' || count(state, 'failed', 'unknown', 'blocked')) status = 'attention';
      else if (status === 'succeeded' && (state.intake === 'open' || count(state, 'waiting-executor', 'awaiting-decision'))) status = 'waiting';
    }
    this.db.query('UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now, this.runId);
  }
}
