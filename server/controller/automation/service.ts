import { randomUUID } from 'node:crypto';
import { AgentCallError, AgentIntegrationError } from '@garcon/server-agent-interface';
import type {
  AutomationResult, AutomationStartInput, AutomationStartResult, AutomationStopResult,
  AutomationTurnKey, ExecutionFailureCertainty,
} from '../../../common/automation.js';
import { CommandRequestValidationError } from '../../../common/chat-command-contracts.js';
import { DomainError } from '../../common/domain-error.js';
import { interactiveDeadline } from '../../common/interactive-deadline.js';
import { waitAbortably } from '../../common/abortable-wait.js';
import { createLogger } from '../../common/log.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatExecutionService } from '../chat-execution/types.js';
import type { TranscriptCommitEvent, TranscriptViewId } from '../ledger/contracts.js';
import { dispatchFailureCertainty } from '../ledger/dispatch-failure.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import { CommandValidationError, type CommandSupport, type NormalizedChatStart } from '../commands/command-support.js';
import type { CommandLedgerRecord } from '../commands/command-ledger.js';
import { startPayload, type StartCommands } from '../commands/start-commands.js';
import { resolvePreambleSelection } from '../preambles/selection.js';
import { LiveSignals, type AcceptAutomationSignal } from './live-signals.js';
import { pinAutomationPreambles, type AutomationAdmission } from './start-admission.js';

const logger = createLogger('automation');
const MAX_PREPARED_AND_LIVE_TURNS = 256;
const COMMAND_TAIL_BUFFER_CHARS = 2048;
const COMMAND_DIAGNOSTIC_MAX_CHARS = 1024;

export interface AutomationServiceOptions {
  readonly serverInstanceId: string;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
  readonly execution: Pick<ChatExecutionService, 'stopExactTurn'>;
  readonly preparationTimeoutMs?: number;
}

export interface PreparedAutomationTurn {
  readonly key: AutomationTurnKey;
  start(): Promise<AutomationStartResult>;
  cancel(): Promise<AutomationStopResult>;
  // Drops observation authority. The owner releases after persisting settlement or abandonment.
  release(): void;
}

export type AutomationPreparation =
  | { readonly kind: 'prepared'; readonly turn: PreparedAutomationTurn }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export interface AutomationExecutionPort {
  prepare(input: AutomationStartInput, options?: { readonly onSignal?: AcceptAutomationSignal }): Promise<AutomationPreparation>;
  waitForTerminal(key: AutomationTurnKey, signal: AbortSignal): Promise<AutomationResult>;
  stop(key: AutomationTurnKey): Promise<AutomationStopResult>;
}

type Terminal = Extract<TranscriptCommitEvent, { type: 'run-ended' }>;
type TerminalEvidence = Pick<Terminal, 'row' | 'commandOutcome' | 'failureCertainty'>;

interface Entry {
  readonly key: AutomationTurnKey;
  readonly record: CommandLedgerRecord;
  readonly cancellation: AbortController;
  readonly admission: AutomationAdmission;
  readonly signals: LiveSignals | null;
  phase: 'prepared' | 'consuming' | 'published' | 'not-started';
  viewId: TranscriptViewId | null;
  terminal: TerminalEvidence | null;
  dispatchFailure: ExecutionFailureCertainty | null;
  gapped: boolean;
  input: NormalizedChatStart | null;
  starting: Promise<AutomationStartResult> | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  stderrTail: string;
  stdoutTail: string;
}

export class AutomationService implements AutomationExecutionPort {
  readonly #entries = new Map<string, Entry>();
  readonly #unsubscribe: () => void;
  #preparing = 0;
  #shuttingDown = false;

  constructor(
    private readonly support: CommandSupport,
    private readonly starts: StartCommands,
    private readonly options: AutomationServiceOptions,
  ) {
    this.#unsubscribe = this.support.deps.transcripts.subscribe(event => this.#observe(event));
  }

  async prepare(request: AutomationStartInput, { onSignal }: { readonly onSignal?: AcceptAutomationSignal } = {}): Promise<AutomationPreparation> {
    if (this.#shuttingDown) return shutdownRejection();
    if (this.#preparing + this.#entries.size >= MAX_PREPARED_AND_LIVE_TURNS) {
      return { kind: 'rejected', code: 'AUTOMATION_CAPACITY', message: 'Too many managed turns are prepared or running.' };
    }
    this.#preparing++;
    try {
      const input = structuredClone(request);
      const chatId = this.options.chatIds.allocate();
      const { agents, preambles, ledger } = this.support.deps;
      const deadline = interactiveDeadline();
      const normalized = await this.starts.normalizeAutomationStart(input, chatId, deadline);
      if (this.#shuttingDown) return shutdownRejection();
      const providerRevision = agents.providerSelectionRevision(normalized);
      if (input.providerRevision !== undefined && input.providerRevision !== providerRevision) {
        throw providerChanged();
      }
      const selection = resolvePreambleSelection(normalized.preambleSelection, preambles.snapshot(), normalized.projectPath, normalized.executorId);
      if (selection.unavailable.length) throw new DomainError('VALIDATION_FAILED', 'A selected preamble is unavailable', 409);
      const cancellation = new AbortController();
      const assertEligible = () => {
        cancellation.signal.throwIfAborted();
        if (onSignal && !agents.supportsLiveStartRows(normalized.agentId, normalized.executorId)) {
          throw new DomainError('OPERATION_UNSUPPORTED', 'This agent cannot attribute live workflow signals. Use completion-only steps with this agent.', 422);
        }
        if (agents.providerSelectionRevision(normalized) !== providerRevision) throw providerChanged();
      };
      assertEligible();
      const key = Object.freeze({ serverInstanceId: this.options.serverInstanceId, chatId, turnId: randomUUID(), clientRequestId: normalized.clientRequestId });
      const reservation = ledger.reserveStart({ ...key, payload: startPayload(normalized) });
      if (reservation.kind !== 'accepted') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Managed start identity is already reserved', 409);

      const entry: Entry = {
        key, record: reservation.record, cancellation,
        admission: { signal: cancellation.signal, providerRevision, assertEligible,
          assertPreambles: pinAutomationPreambles(selection.eligible), inputPublished: false,
          dispatchFailed: error => { entry.dispatchFailure = dispatchFailureCertainty(error); } },
        signals: onSignal ? new LiveSignals(this.support.deps.transcripts, key,
          () => this.#entries.get(chatId) === entry && !entry.cancellation.signal.aborted
            && !entry.stopRequested && entry.phase === 'published' && entry.terminal?.failureCertainty !== 'unknown', onSignal) : null,
        phase: 'prepared', viewId: null, terminal: null, dispatchFailure: null, gapped: false,
        input: normalized, starting: null, timer: null, stopRequested: false, stderrTail: '', stdoutTail: '',
      };
      this.#entries.set(chatId, entry);
      entry.timer = setTimeout(() => {
        void this.#cancelPrepared(entry).catch(error => logger.error('Managed start expiration failed', { chatId, error: String(error) }));
      }, this.options.preparationTimeoutMs ?? 30_000);
      entry.timer.unref();
      return { kind: 'prepared', turn: {
        key, start: () => this.#start(entry), cancel: () => this.stop(key), release: () => this.#release(entry),
      } };
    } catch (error) {
      return { kind: 'rejected', code: errorCode(error, 'AUTOMATION_PREPARATION_FAILED'), message: errorMessage(error) };
    } finally {
      this.#preparing--;
    }
  }

  async waitForTerminal(key: AutomationTurnKey, signal: AbortSignal): Promise<AutomationResult> {
    signal.throwIfAborted();
    if (key.serverInstanceId !== this.options.serverInstanceId) return unavailable();
    const entry = this.#find(key);
    const ledger = this.support.deps.ledger;
    if (!entry) {
      const record = await ledger.getTurnRecord(key.chatId, key.turnId);
      return withoutObservation(key, record);
    }
    const record = await ledger.waitForTurnTerminal(key.chatId, key.turnId, signal);
    if (!record) return withoutObservation(key, await ledger.getTurnRecord(key.chatId, key.turnId));
    if (record.clientRequestId !== key.clientRequestId || this.#find(key) !== entry) return unavailable();
    if (entry.signals) {
      const fault = await waitAbortably(entry.signals.drain(), signal);
      if (this.#find(key) !== entry) return unavailable();
      if (record.status === 'finished' && !record.interruptionReason) {
        if (fault) return { kind: 'unavailable', reason: fault };
        if (entry.gapped) return { kind: 'unavailable', reason: 'Some executor output was lost; signal intake could not be confirmed.' };
      }
    }
    return terminalResult(entry, record);
  }

  async stop(key: AutomationTurnKey): Promise<AutomationStopResult> {
    if (key.serverInstanceId !== this.options.serverInstanceId) return { kind: 'requires-explicit-chat-stop', chatId: key.chatId };
    const entry = this.#find(key);
    if (entry?.phase === 'prepared') {
      await this.#cancelPrepared(entry);
      return { kind: 'not-started' };
    }
    if (entry?.phase === 'consuming') {
      entry.cancellation.abort(canceled());
      const start = await entry.starting;
      if (start?.kind === 'not-started') return { kind: 'not-started' };
    }
    return this.support.withChatMutationLock(key.chatId, async () => {
      const record = await this.support.deps.ledger.getTurnRecord(key.chatId, key.turnId);
      if (!record || record.clientRequestId !== key.clientRequestId) return { kind: 'stale-target' };
      if (record.publicTerminalAt) return { kind: 'already-settled' };
      if (record.retainedPrivateTerminal) return { kind: 'not-started' };
      if (!entry || this.#find(key) !== entry) return { kind: 'stale-target' };
      if (entry.stopRequested) return { kind: 'stop-requested', delivery: 'unknown' };
      const outcome = await this.options.execution.stopExactTurn(key.chatId, key);
      if (outcome === 'stale-target') return { kind: 'stale-target' };
      if (outcome === 'interrupt-requested') {
        entry.stopRequested = true;
        return { kind: 'stop-requested', delivery: 'unknown' };
      }
      if (entry.terminal || (await this.support.deps.ledger.getTurnRecord(key.chatId, key.turnId))?.publicTerminalAt) {
        return { kind: 'already-settled' };
      }
      return { kind: 'unknown', reason: 'The exact turn interruption was not confirmed.' };
    });
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    this.#unsubscribe();
    for (const entry of this.#entries.values()) this.#release(entry);
  }

  #find(key: AutomationTurnKey): Entry | undefined {
    const entry = this.#entries.get(key.chatId);
    return entry?.key.turnId === key.turnId && entry.key.clientRequestId === key.clientRequestId ? entry : undefined;
  }

  #observe(event: TranscriptCommitEvent): void {
    if (event.type !== 'rows' && event.type !== 'run-ended') return;
    const entry = this.#entries.get(event.chatId);
    if (entry?.phase !== 'published' || entry.viewId !== event.viewId) return;
    if (event.type === 'run-ended' && event.runId === entry.key.turnId) {
      const { row, commandOutcome, failureCertainty } = event;
      entry.terminal = { row, commandOutcome, failureCertainty };
    } else if (event.type === 'rows') {
      if (event.publicationGapRunId === entry.key.turnId) entry.gapped = true;
      if (!entry.terminal) {
        for (const row of event.rows) {
          if (row.kind !== 'provider-row' || row.message.type !== 'command-output' || !row.message.content) continue;
          if (row.message.channel === 'stderr') entry.stderrTail = appendBoundedTail(entry.stderrTail, row.message.content);
          else if (row.message.channel === 'stdout') entry.stdoutTail = appendBoundedTail(entry.stdoutTail, row.message.content);
        }
      }
      if (event.liveAssistantRows?.runId === entry.key.turnId && !entry.terminal) {
        entry.signals?.collect(event.viewId, event.liveAssistantRows.rows);
      }
    }
  }

  #start(entry: Entry): Promise<AutomationStartResult> {
    if (entry.starting) return entry.starting;
    if (entry.phase !== 'prepared' || this.#shuttingDown) {
      return Promise.resolve({ kind: 'not-started', code: 'AUTOMATION_START_CANCELED', inputPublished: false });
    }
    this.#clearTimer(entry);
    entry.phase = 'consuming';
    entry.starting = this.#consume(entry);
    return entry.starting;
  }

  async #consume(entry: Entry): Promise<AutomationStartResult> {
    const dispatchReady = Promise.withResolvers<void>();
    const input = entry.input!;
    entry.input = null;
    try {
      await this.support.withChatMutationLock(entry.key.chatId, async deadline => {
        entry.admission.assertEligible();
        this.support.deps.agents.assertExecutorReady(input.executorId);
        await this.starts.consumeAutomationStartLocked(input, entry.record, entry.admission, deadline, dispatchReady.promise);
        entry.viewId = this.support.deps.transcripts.existingCurrentView(entry.key.chatId)?.viewId ?? null;
        entry.cancellation.signal.throwIfAborted();
        entry.phase = 'published';
      });
      return { kind: 'published' };
    } catch (error) {
      entry.phase = 'not-started';
      const code = entry.cancellation.signal.aborted ? 'AUTOMATION_START_CANCELED' : errorCode(error, 'AUTOMATION_ADMISSION_FAILED');
      entry.cancellation.abort(canceled());
      // A scheduled dispatch is also canceled before the gate opens.
      try {
        await this.#settleNotStarted(entry, code, errorMessage(error));
      } finally {
        this.#entries.delete(entry.key.chatId);
      }
      return { kind: 'not-started', code, inputPublished: entry.admission.inputPublished };
    } finally {
      dispatchReady.resolve();
    }
  }

  async #cancelPrepared(entry: Entry): Promise<void> {
    if (entry.phase !== 'prepared') return;
    entry.phase = 'not-started';
    this.#clearTimer(entry);
    entry.input = null;
    entry.cancellation.abort(canceled());
    try {
      await this.#settleNotStarted(entry, 'AUTOMATION_START_CANCELED', 'Managed start was canceled before dispatch.');
    } finally {
      this.#entries.delete(entry.key.chatId);
    }
  }

  #settleNotStarted(entry: Entry, code: string, message: string) {
    return this.support.deps.ledger.settleTerminal(entry.record.key, 'failed', {
      retainedPrivateTerminal: true, errorCode: code, error: message,
    });
  }

  #release(entry: Entry): void {
    if (this.#find(entry.key) !== entry) return;
    if (entry.phase === 'prepared') {
      void this.#cancelPrepared(entry).catch(error => logger.error('Managed start cancellation failed', { chatId: entry.key.chatId, error: String(error) }));
      return;
    }
    entry.cancellation.abort(canceled());
    this.#entries.delete(entry.key.chatId);
  }

  #clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function appendBoundedTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > COMMAND_TAIL_BUFFER_CHARS ? combined.slice(-COMMAND_TAIL_BUFFER_CHARS) : combined;
}

function commandFailureDiagnostic(entry: Entry, commandOutcome: TerminalEvidence['commandOutcome'] | null): string | null {
  if (!commandOutcome) return null;
  if (commandOutcome.outcome === 'finished' && commandOutcome.exitCode === 0 && commandOutcome.signal === null) return null;
  const raw = (entry.stderrTail.trim() ? entry.stderrTail : entry.stdoutTail).trimEnd();
  if (!raw) return null;
  if (raw.length <= COMMAND_DIAGNOSTIC_MAX_CHARS) return raw;
  return '...' + raw.slice(-(COMMAND_DIAGNOSTIC_MAX_CHARS - 3));
}

function terminalResult(entry: Entry, record: CommandLedgerRecord): AutomationResult {
  const terminal = entry.terminal;
  const projected = projectAgentTurnReceipt(record);
  if (projected.kind === 'expired') {
    // Expiration retires only output, not the confirmed exact terminal.
    return terminalResult(entry, { ...record, turnResult: undefined });
  }
  const receipt = projected.receipt;
  const commandOutcome = terminal?.commandOutcome ?? null;
  const commandDiagnostic = commandFailureDiagnostic(entry, commandOutcome);
  switch (receipt.state) {
    case 'completed': {
      if (terminal?.row.outcome !== 'finished' || terminal.row.origin !== 'provider') return unavailable();
      const completeText = !entry.gapped && (!commandOutcome || commandOutcome.capture === 'complete')
        && receipt.output.availability === 'available' && receipt.output.completeness === 'complete' ? receipt.output.text : null;
      return { kind: 'completed', receipt, completeText, commandOutcome, ...(commandDiagnostic ? { commandDiagnostic } : {}) };
    }
    case 'failed': {
      const certainty = receipt.errorCode === 'OUTCOME_UNKNOWN' ? 'unknown'
        : terminal?.failureCertainty ?? entry.dispatchFailure ?? 'unknown';
      return { kind: 'failed', certainty, receipt, detail: receipt.error, commandOutcome, ...(commandDiagnostic ? { commandDiagnostic } : {}) };
    }
    case 'interrupted':
      return { kind: 'interrupted', receipt, termination: terminal?.row.origin === 'provider' ? 'observed' : 'requested' };
    default:
      return unavailable();
  }
}

function withoutObservation(key: AutomationTurnKey, record: CommandLedgerRecord | null): AutomationResult {
  if (record?.clientRequestId === key.clientRequestId && record.retainedPrivateTerminal) {
    return { kind: 'failed', certainty: 'not-started', receipt: null, detail: record.error ?? 'Managed turn was not started.', commandOutcome: null };
  }
  return unavailable();
}

function unavailable(): AutomationResult {
  return { kind: 'unavailable', reason: 'The process-local managed turn observation is unavailable.' };
}

function shutdownRejection(): AutomationPreparation {
  return { kind: 'rejected', code: 'SERVER_SHUTTING_DOWN', message: 'The server is shutting down.' };
}

function providerChanged(): DomainError {
  return new DomainError('API_PROVIDER_CONFIGURATION_CHANGED', 'Provider configuration changed before the managed start', 409);
}

function canceled(): AgentCallError {
  return new AgentCallError('not-dispatched', 'Managed start was canceled');
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof CommandRequestValidationError) return 'VALIDATION_FAILED';
  return error instanceof DomainError || error instanceof CommandValidationError || error instanceof AgentIntegrationError ? error.code : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Managed turn could not start.';
}
