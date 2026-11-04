import { randomUUID } from 'node:crypto';
import { AgentCallError } from '@garcon/server-agent-interface';
import type {
  AutomationResult, AutomationStartInput, AutomationStartResult, AutomationStopResult,
  AutomationTurnKey, EffectiveAutomationInput,
} from '../../../common/automation.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatExecutionService } from '../chat-execution/types.js';
import type { CommandSupport, NormalizedChatStart } from '../commands/command-support.js';
import type { CommandLedgerRecord } from '../commands/command-ledger.js';
import { StartCommands, startPayload } from '../commands/start-commands.js';
import { interactiveDeadline } from '../../common/interactive-deadline.js';
import { DomainError } from '../../common/domain-error.js';
import { resolvePreambleSelection } from '../preambles/selection.js';
import type { OutputCoverageWatch } from '../ledger/output-coverage.js';
import { assertAutomationPreambles, automationContentDigest, automationInputDigest, type AutomationInputConstraints } from './input.js';
import type { AutomationControlLease, AutomationLifecycle } from './lifecycle.js';
import { automationTerminalResult } from './results.js';

export interface PreparedAutomationTurn {
  readonly key: AutomationTurnKey;
  readonly effectiveInput: EffectiveAutomationInput;
  readonly control: Pick<AutomationControlLease, 'revoked' | 'release'> & {
    // Checked again immediately before accepting output; terminals may precede gaps.
    readonly outputGapped: AbortSignal;
  };
  start(): Promise<AutomationStartResult>;
  cancel(): Promise<void>;
}

export interface AutomationServiceOptions {
  readonly serverInstanceId: string;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
  readonly lifecycle: AutomationLifecycle;
  readonly execution: Pick<ChatExecutionService, 'stopExactTurn'>;
  readonly providerRevision: (input: NormalizedChatStart) => number | null;
  readonly preparationTimeoutMs?: number;
}

interface PreparedEntry {
  readonly cancellation: AbortController;
  readonly key: AutomationTurnKey;
  readonly record: CommandLedgerRecord;
  readonly constraints: AutomationInputConstraints;
  readonly outputCoverage: OutputCoverageWatch;
  input: NormalizedChatStart | null;
  phase: 'prepared' | 'consuming' | 'published' | 'not-started';
  timer: ReturnType<typeof setTimeout> | null;
  starting: Promise<AutomationStartResult> | null;
  stopRequested: boolean;
}

export class AutomationService {
  readonly #entries = new Map<string, PreparedEntry>();
  #preparing = 0;
  #shuttingDown = false;

  constructor(
    private readonly support: CommandSupport,
    private readonly starts: StartCommands,
    private readonly options: AutomationServiceOptions,
  ) {}

  async prepare(request: AutomationStartInput): Promise<
    { kind: 'prepared'; turn: PreparedAutomationTurn } | { kind: 'rejected'; code: string }
  > {
    if (this.#shuttingDown) return { kind: 'rejected', code: 'SERVER_SHUTTING_DOWN' };
    if (this.#entries.size + this.#preparing >= 256) return { kind: 'rejected', code: 'AUTOMATION_CAPACITY' };
    this.#preparing++;
    let control: AutomationControlLease | null = null;
    try {
      const input = structuredClone(request);
      const chatId = this.options.chatIds.allocate();
      const normalized = await this.starts.normalizeAutomationStart(input, chatId, interactiveDeadline());
      if (this.#shuttingDown) return { kind: 'rejected', code: 'SERVER_SHUTTING_DOWN' };
      const resolved = resolvePreambleSelection(normalized.preambleSelection, this.support.deps.preambles.snapshot(), normalized.projectPath, normalized.executorId);
      if (resolved.unavailable.length) return { kind: 'rejected', code: 'AUTOMATION_INPUT_CHANGED' };
      assertAutomationPreambles(input.preambles, resolved.eligible);
      const providerRevision = this.options.providerRevision(normalized);
      if (input.providerRevision !== providerRevision) return { kind: 'rejected', code: 'API_PROVIDER_CONFIGURATION_CHANGED' };
      const manifest = {
        executorId: normalized.executorId, projectPath: normalized.projectPath,
        promptDigest: automationContentDigest(normalized.command), preambles: input.preambles,
        selectionDigest: automationInputDigest({ agentId: normalized.agentId, model: normalized.model,
          apiProviderId: normalized.apiProviderId, modelEndpointId: normalized.modelEndpointId }),
        providerRevision,
        settingsDigest: automationInputDigest({ permissionMode: normalized.permissionMode,
          thinkingMode: normalized.thinkingMode, agentSettings: normalized.agentSettings }),
      };
      const effective: EffectiveAutomationInput = { ...manifest, digest: automationInputDigest(manifest) };
      const key = Object.freeze({ serverInstanceId: this.options.serverInstanceId, chatId, turnId: randomUUID(), clientRequestId: input.clientRequestId });
      control = this.options.lifecycle.acquire(key);
      const reserved = this.support.deps.ledger.reserveStart({ ...key, payload: startPayload(normalized) });
      if (reserved.kind !== 'accepted') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Automation start identity is already reserved', 409);
      const cancellation = new AbortController();
      const entry: PreparedEntry = {
        key, record: reserved.record, cancellation,
        constraints: { control, effective, canceled: cancellation.signal, inputPublished: false },
        outputCoverage: this.support.deps.transcripts.outputCoverage.watch(chatId),
        input: normalized, phase: 'prepared', timer: null, starting: null, stopRequested: false,
      };
      this.#entries.set(key.turnId, entry);
      entry.timer = setTimeout(() => { void this.#cancel(entry); }, this.options.preparationTimeoutMs ?? 30_000);
      entry.timer.unref();
      return { kind: 'prepared', turn: {
        key, effectiveInput: structuredClone(effective),
        control: { revoked: control.revoked, outputGapped: entry.outputCoverage.gapped, release: () => {
          if (entry.phase === 'prepared' || entry.phase === 'consuming') { void this.#cancel(entry); return; }
          this.#release(entry);
        } },
        start: () => this.#start(entry), cancel: () => this.#cancel(entry),
      } };
    } catch (error) {
      control?.release();
      return { kind: 'rejected', code: error instanceof DomainError ? error.code : 'AUTOMATION_PREPARATION_FAILED' };
    } finally {
      this.#preparing--;
    }
  }

  async waitForTerminal(key: AutomationTurnKey, signal: AbortSignal): Promise<AutomationResult> {
    if (key.serverInstanceId !== this.options.serverInstanceId) return automationTerminalResult(null);
    const record = await this.support.deps.ledger.waitForTurnTerminal(key.chatId, key.turnId, signal);
    if (record) return this.#result(key, record);
    const privateRecord = await this.support.deps.ledger.getTurnRecord(key.chatId, key.turnId);
    if (privateRecord?.retainedPrivateTerminal && privateRecord.clientRequestId === key.clientRequestId) return {
      kind: 'failed', certainty: 'not-started', receipt: null, detail: privateRecord.error ?? 'Automation was not started',
      commandOutcome: null, receivedOutputCoverage: 'unknown',
    };
    return automationTerminalResult(null);
  }

  async stop(key: AutomationTurnKey): Promise<AutomationStopResult> {
    if (key.serverInstanceId !== this.options.serverInstanceId) return { kind: 'requires-explicit-chat-stop', chatId: key.chatId };
    const candidate = this.#entries.get(key.turnId);
    const entry = candidate?.key.chatId === key.chatId && candidate.key.clientRequestId === key.clientRequestId ? candidate : undefined;
    if (candidate && !entry) return { kind: 'stale-target' };
    if (entry?.phase === 'prepared') {
      await this.#cancel(entry);
      return { kind: 'not-started' };
    }
    return this.support.withChatMutationLock(key.chatId, async () => {
      const record = await this.support.deps.ledger.getTurnRecord(key.chatId, key.turnId);
      if (!record) return { kind: 'unknown', reason: 'The process-local turn observation is unavailable.' };
      if (record.clientRequestId !== key.clientRequestId) return { kind: 'stale-target' };
      if (record.publicTerminalAt) return { kind: 'already-settled', result: this.#result(key, record) };
      if (record.retainedPrivateTerminal) return { kind: 'not-started' };
      if (!entry || !this.options.lifecycle.ownsControl(entry.constraints.control)) return { kind: 'stale-target' };
      if (entry.stopRequested) return { kind: 'stop-requested', delivery: 'unknown' };
      const outcome = await this.options.execution.stopExactTurn(entry.constraints.control);
      if (outcome === 'stale-target') return { kind: 'stale-target' };
      if (outcome === 'interrupt-requested') {
        entry.stopRequested = true;
        return { kind: 'stop-requested', delivery: 'unknown' };
      }
      const settled = await this.support.deps.ledger.getTurnRecord(key.chatId, key.turnId);
      if (settled?.publicTerminalAt) return { kind: 'already-settled', result: this.#result(key, settled) };
      return { kind: 'unknown', reason: 'Exact-turn interruption could not be confirmed' };
    });
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    for (const entry of this.#entries.values()) {
      if (entry.phase === 'prepared') void this.#cancel(entry);
      if (entry.phase === 'consuming') entry.cancellation.abort(new AgentCallError('not-dispatched', 'Server is shutting down'));
    }
  }

  #result(key: AutomationTurnKey, record: CommandLedgerRecord): AutomationResult {
    const result = automationTerminalResult(record.clientRequestId === key.clientRequestId ? record : null);
    const entry = this.#entries.get(key.turnId);
    return entry?.key.chatId === key.chatId && entry.outputCoverage.gapped.aborted
      ? { ...result, receivedOutputCoverage: 'gapped' } : result;
  }

  #start(entry: PreparedEntry): Promise<AutomationStartResult> {
    if (entry.starting) return entry.starting;
    if (entry.phase !== 'prepared' || this.#shuttingDown) return Promise.resolve({ kind: 'not-started', code: 'AUTOMATION_START_CANCELED', inputPublished: false });
    entry.phase = 'consuming';
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.starting = this.#consume(entry);
    return entry.starting;
  }

  async #consume(entry: PreparedEntry): Promise<AutomationStartResult> {
    const gate = Promise.withResolvers<void>();
    const input = entry.input!;
    entry.input = null;
    try {
      await this.support.withChatMutationLock(entry.key.chatId, async deadline => {
        if (this.#shuttingDown) throw new DomainError('SERVER_SHUTTING_DOWN', 'Server is shutting down', 503);
        entry.constraints.control.revoked.throwIfAborted();
        entry.constraints.canceled.throwIfAborted();
        this.support.deps.agents.assertExecutorReady(input.executorId);
        if (this.options.providerRevision(input) !== entry.constraints.effective.providerRevision) {
          throw new DomainError('API_PROVIDER_CONFIGURATION_CHANGED', 'Provider configuration changed', 409);
        }
        await this.starts.consumeAutomationStartLocked(input, entry.record, entry.constraints, deadline, gate.promise);
      });
      entry.constraints.canceled.throwIfAborted();
      entry.phase = 'published';
      return { kind: 'published' };
    } catch (error) {
      entry.phase = 'not-started';
      await this.support.deps.ledger.settleTerminal(entry.record.key, 'failed', {
        retainedPrivateTerminal: true, errorCode: 'AUTOMATION_ADMISSION_FAILED',
        error: error instanceof Error ? error.message : 'Automation admission failed',
      });
      this.#release(entry);
      return { kind: 'not-started', code: error instanceof DomainError ? error.code
        : entry.constraints.canceled.aborted ? 'AUTOMATION_START_CANCELED' : 'AUTOMATION_ADMISSION_FAILED',
      inputPublished: entry.constraints.inputPublished };
    } finally {
      // Releasing the shared lock precedes opening the tracked dispatch gate.
      gate.resolve();
    }
  }

  async #cancel(entry: PreparedEntry): Promise<void> {
    if (entry.phase === 'consuming') {
      entry.cancellation.abort(new AgentCallError('not-dispatched', 'Automation start was canceled'));
      await entry.starting;
      if (entry.phase as string === 'published') await this.stop(entry.key);
      return;
    }
    if (entry.phase === 'published') { await this.stop(entry.key); return; }
    if (entry.phase === 'not-started') return;
    entry.phase = 'not-started';
    entry.input = null;
    await this.support.deps.ledger.cancelStartReservation(entry.record.key);
    this.#release(entry);
  }

  #release(entry: PreparedEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.constraints.control.release();
    entry.outputCoverage.release();
    this.#entries.delete(entry.key.turnId);
  }
}
