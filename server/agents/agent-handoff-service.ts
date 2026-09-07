import crypto from 'node:crypto';
import type {
  AgentHandoffRequest,
} from '../../common/chat-command-contracts.js';
import type { AgentCatalogEntry } from '../../common/agents.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { DirectInputPreparationContext } from '../chat-execution/types.js';
import {
  type AgentHandoffIntent,
  type AgentOwnershipJournal,
  matchesHandoffTarget,
} from '../chats/agent-ownership-journal.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { IntegrationRegistry } from './integration-registry.js';
import type { ResolvedAgentHandoffTarget } from './agent-handoff-types.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { LedgerAgentSwitchRow, TranscriptWatermark } from '../ledger/contracts.js';
import { frozenConversationDrafts } from '../ledger/projection.js';
import type { CarryOverCompactionInput } from '../chats/carryover-compaction.js';
import type { CarryOverOutcome } from '../chats/carryover-outcome.js';
import type { PreparedCarryover } from '../chats/prepared-carryover.js';
import { OwnershipTransferPendingError } from './ownership-transfer-fence.js';
import { isThinkingModeSupported } from '../../common/execution-defaults.js';

const logger = createLogger('agents:handoff');
const MAX_RECOVERY_RETRY_DELAY_MS = 1_000;
const INITIAL_RECOVERY_RETRY_DELAY_MS = 25;
const REQUEST_ROLL_FORWARD_ATTEMPTS = 3;

type HandoffRecoveryStep = 'ledger-boundary' | 'registry' | 'journal' | 'producer' | 'fenced';

interface PendingHandoffRecovery {
  readonly intent: AgentHandoffIntent;
  step: HandoffRecoveryStep;
}

interface CarryoverPlanningPort {
  planFor(input: CarryOverCompactionInput): Promise<CarryOverOutcome>;
}

interface PreparedCarryoverPort {
  deposit(value: PreparedCarryover): void;
  discard(chatId: string): void;
}

export interface AgentHandoffPreparation {
  readonly operation: 'agent-handoff';
  prepare(context: DirectInputPreparationContext): Promise<void>;
  compensate(): Promise<void>;
}

export class AgentHandoffService {
  readonly #recoveries = new Map<string, PendingHandoffRecovery>();
  readonly #activeRecoveryAttempts = new Map<string, Promise<void>>();
  readonly #recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #carryoverPreparations = new Map<string, AbortController>();
  readonly #shutdownController = new AbortController();

  constructor(private readonly deps: {
    readonly registry: IChatRegistry;
    readonly integrations: IntegrationRegistry;
    readonly endpointResolver: ApiProviderEndpointResolver;
    readonly catalog: {
      getAgentCatalogEntry(agentId: string): Promise<AgentCatalogEntry | null>;
    };
    readonly ownership: AgentOwnershipJournal;
    readonly ledger: TranscriptLedgerService;
    readonly carryover: CarryoverPlanningPort;
    readonly preparedCarryover: PreparedCarryoverPort;
    readonly reopenProducer: (chatId: string) => void;
    readonly onCommitted?: (chatId: string) => void | Promise<void>;
  }) {}

  shutdown(): void {
    if (this.#shutdownController.signal.aborted) return;
    const reason = new Error('Agent handoff service shut down');
    this.#shutdownController.abort(reason);
    for (const controller of this.#carryoverPreparations.values()) controller.abort(reason);
    this.#carryoverPreparations.clear();
    for (const timer of this.#recoveryTimers.values()) clearTimeout(timer);
    this.#recoveryTimers.clear();
  }

  cancelPreparation(chatId: string): void {
    this.#carryoverPreparations.get(chatId)?.abort(new Error('Turn interrupted by the user'));
  }

  seedContinuationLedger(input: {
    readonly sourceChatId: string;
    readonly targetChatId: string;
  }): TranscriptWatermark {
    if (this.deps.ledger.currentView(input.targetChatId)) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        `Session already exists: ${input.targetChatId}`,
        409,
      );
    }
    const watermark = this.deps.ledger.highWatermark(input.sourceChatId);
    const rows = frozenConversationDrafts(
      this.deps.ledger.rowsThrough(input.sourceChatId, watermark),
    );
    this.deps.ledger.initializeChat(input.targetChatId, rows, rows.length + 1);
    return watermark;
  }

  deleteContinuationLedger(chatId: string): void {
    this.deps.ledger.deleteChat(chatId);
  }

  async resolveTarget(input: {
    readonly chat: ChatRegistryEntry;
    readonly handoff: AgentHandoffRequest;
    readonly permissionFallbackPolicy?: 'require-explicit-bypass';
  }): Promise<ResolvedAgentHandoffTarget> {
    if (input.handoff.expectedAgentOwnershipEpoch !== input.chat.agentOwnershipEpoch) {
      throw new DomainError(
        'STALE_CHAT_OWNERSHIP',
        'The chat owner changed before this handoff was submitted.',
        409,
      );
    }
    const requested = input.handoff.target;
    if (requested.agentId === input.chat.agentId) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'A handoff target must differ from the current chat owner.',
        400,
      );
    }
    const integration = this.deps.integrations.get(requested.agentId);
    const catalog = await this.deps.catalog.getAgentCatalogEntry(requested.agentId);
    if (!integration || !catalog) {
      throw new DomainError(
        'UNSUPPORTED_AGENT',
        `Unsupported agent: ${requested.agentId}`,
        422,
      );
    }
    const selection = this.deps.endpointResolver.resolveSelection({
      agentId: requested.agentId,
      model: requested.model,
      apiProviderId: requested.apiProviderId,
      modelEndpointId: requested.modelEndpointId,
    });
    if (requested.modelProtocol !== undefined && requested.modelProtocol !== selection.protocol) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'The handoff model protocol does not match its resolved endpoint.',
        422,
      );
    }
    const endpoint = this.deps.endpointResolver.resolveEndpointReference(selection);
    if (endpoint) {
      if (!integration.endpoints) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `Agent ${requested.agentId} does not accept API provider endpoints.`,
          422,
        );
      }
      await integration.endpoints.validate({
        apiProviderId: selection.apiProviderId!,
        endpointId: selection.endpointId!,
        providerLabel: endpoint.apiProvider.label || selection.apiProviderId!,
        protocol: selection.protocol!,
        baseUrl: endpoint.endpoint.baseUrl,
        model: selection.model,
        isLocal: selection.isLocal,
        capabilities: endpoint.endpoint.capabilities ?? null,
        headers: { ...(endpoint.endpoint.headers ?? {}) },
        credential: {
          kind: 'api-provider-endpoint',
          apiProviderId: selection.apiProviderId!,
          endpointId: selection.endpointId!,
        },
      });
    }

    const permissionMode = requested.permissionMode ?? preferredValue(
      catalog.supportedPermissionModes,
      'default',
    );
    const thinkingMode = requested.thinkingMode ?? preferredValue(
      catalog.supportedThinkingModes,
      'none',
    );
    assertSupported(catalog.supportedPermissionModes, permissionMode, 'permission mode');
    if (!isThinkingModeSupported(thinkingMode, catalog.supportedThinkingModes)) {
      throwUnsupported(thinkingMode, 'reasoning effort');
    }
    if (
      input.permissionFallbackPolicy === 'require-explicit-bypass'
      && requested.permissionMode === undefined
      && (permissionMode === 'manualBypass' || permissionMode === 'bypassPermissions')
    ) {
      throw new DomainError(
        'EXPLICIT_BYPASS_REQUIRED',
        `Resolved permission mode ${permissionMode} requires an explicit override.`,
        422,
      );
    }
    const agentSettings = integration.settings.parse(
      requested.agentSettings
        ?? input.chat.agentSettingsById[requested.agentId]
        ?? integration.settings.defaults(),
    );
    if (agentSettings.ownerId !== requested.agentId) {
      throw new DomainError(
        'INCOMPLETE_EXECUTION_CONFIG',
        `The chat has no valid settings for agent ${requested.agentId}.`,
        422,
      );
    }
    return {
      agentId: requested.agentId,
      model: selection.model,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
      permissionMode,
      thinkingMode,
      agentSettings,
    };
  }

  createPreparation(input: {
    readonly chatId: string;
    readonly clientRequestId: string;
    readonly handoff: AgentHandoffRequest;
    readonly source: ChatRegistryEntry;
    readonly target: ResolvedAgentHandoffTarget;
    readonly command: string;
  }): AgentHandoffPreparation {
    const operationId = handoffOperationId(input.chatId, input.clientRequestId);
    const submittedTargetHash = handoffTargetHash(input.handoff);
    const sourceSnapshot = cloneRegistryEntry(input.source);
    const sourceFence = ownershipFence(sourceSnapshot);
    let completed = false;

    return {
      operation: 'agent-handoff',
      prepare: async (context) => {
        this.#shutdownController.signal.throwIfAborted();
        let decisionAttempted = false;
        let producerClosed = false;
        try {
          this.#requireUnchangedSource(input.chatId, sourceFence);
          const existing = this.deps.ownership.findHandoff(
            input.chatId,
            input.clientRequestId,
          );
          if (existing) {
            assertMatchingHandoff(existing, submittedTargetHash);
            await this.#rollForwardPersistedHandoff(existing);
            completed = true;
            await this.#notifyCommitted(input.chatId);
            return;
          }

          context.assertAdmissionActive();
          this.deps.ledger.closeProducer(input.chatId);
          producerClosed = true;
          const watermark = this.deps.ledger.highWatermark(input.chatId);
          const checkpoint = this.deps.ledger.checkpointForHandoff(input.chatId);
          if (checkpoint.viewId !== watermark.viewId || checkpoint.ordinal !== watermark.ordinal) {
            throw new Error('Transcript changed while the handoff checkpoint was captured');
          }
          const planningController = new AbortController();
          this.#carryoverPreparations.set(input.chatId, planningController);
          let planned: CarryOverOutcome;
          try {
            planned = await this.deps.carryover.planFor({
              operation: 'agent-switch',
              chatId: input.chatId,
              projectPath: sourceSnapshot.projectPath,
              messages: this.deps.ledger.conversationMessages(input.chatId),
              destination: {
                agentId: input.target.agentId,
                model: input.target.model,
                prompt: input.command,
              },
              signal: AbortSignal.any([context.signal, planningController.signal]),
            });
          } finally {
            if (this.#carryoverPreparations.get(input.chatId) === planningController) {
              this.#carryoverPreparations.delete(input.chatId);
            }
          }
          this.#requireUnchangedSource(input.chatId, sourceFence);
          context.assertAdmissionActive();
          decisionAttempted = true;
          const intent = await this.deps.ownership.decideHandoff({
            operationId,
            clientRequestId: input.clientRequestId,
            submittedTargetHash,
            chatId: input.chatId,
            source: sourceSnapshot,
            target: input.target,
            targetAgentOwnershipEpoch: crypto.randomUUID(),
            watermark,
          });
          await this.#rollForwardPersistedHandoff(intent);
          this.deps.preparedCarryover.deposit({
            chatId: input.chatId,
            transcriptViewId: checkpoint.viewId,
            targetAgentId: input.target.agentId,
            clientRequestId: input.clientRequestId,
            result: planned,
          });
          completed = true;
          await this.#notifyCommitted(input.chatId);
        } catch (error) {
          if (error instanceof OwnershipTransferPendingError) throw error;
          const retained = this.deps.ownership.findHandoff(
            input.chatId,
            input.clientRequestId,
          );
          if (decisionAttempted && retained) {
            assertMatchingHandoff(retained, submittedTargetHash);
            await this.#rollForwardPersistedHandoff(retained);
            completed = true;
            await this.#notifyCommitted(input.chatId);
            return;
          }
          if (producerClosed) this.deps.reopenProducer(input.chatId);
          throw error;
        }
      },
      compensate: async () => {
        this.deps.preparedCarryover.discard(input.chatId);
        if (completed) return;
      },
    };
  }

  async recoverPendingHandoffs(): Promise<void> {
    if (this.#shutdownController.signal.aborted) return;
    await Promise.all(
      this.deps.ownership.pendingHandoffs().map((intent) => {
        return this.#recoverHandoff(this.#ensureRecovery(intent), 0);
      }),
    );
  }

  async #rollForwardPersistedHandoff(intent: AgentHandoffIntent): Promise<void> {
    this.#disarmHandoffRecovery(intent.operationId);
    this.deps.ledger.closeProducer(intent.chatId);
    try {
      await retryHandoffStep(
        'ledger boundary recovery',
        () => this.#applyLedgerBoundary(intent),
        this.#shutdownController.signal,
        'ledger-boundary',
      );
      await retryHandoffStep(
        'registry recovery',
        () => this.deps.ownership.applyHandoffDecision(intent.operationId),
        this.#shutdownController.signal,
        'registry',
      );
      // The journal entry is the pending-ownership fence, and reopening the producer is a
      // publication. Discharging the intent first keeps roll-forward from fencing itself.
      await retryHandoffStep(
        'journal recovery',
        () => this.#completeHandoffIfPending(intent),
        this.#shutdownController.signal,
        'journal',
      );
      await retryHandoffStep(
        'producer recovery',
        () => this.deps.reopenProducer(intent.chatId),
        this.#shutdownController.signal,
        'producer',
      );
    } catch (error) {
      if (!(error instanceof HandoffStepRetryLimitError)) throw error;
      const recovery = this.#ensureRecovery(intent, error.step);
      this.#scheduleHandoffRecovery(recovery, 0);
      throw new OwnershipTransferPendingError(error);
    }
  }

  #applyLedgerBoundary(intent: AgentHandoffIntent): void {
    const markers = this.deps.ledger.rowsAfter(
      intent.chatId,
      intent.watermark.viewId,
      intent.watermark.ordinal,
    ).filter((row): row is LedgerAgentSwitchRow => row.kind === 'agent-switch');
    if (markers.length > 1 || markers.some((marker) => !matchesSwitchMarker(marker, intent))) {
      throw new HandoffBoundaryCorruptionError(intent.chatId);
    }
    const marker = markers[0]
      ?? this.deps.ledger.appendAgentSwitch(intent.chatId, intent.watermark.viewId, {
        fromAgentId: intent.source.agentId,
        toAgentId: intent.target.execution.agentId,
        fromModel: this.deps.registry.getChat(intent.chatId)?.model ?? null,
        toModel: intent.target.execution.model ?? null,
      });
    this.deps.ledger.advanceContentStart(
      intent.chatId,
      intent.watermark.viewId,
      marker.ordinal + 1,
    );
  }

  #recoverHandoff(recovery: PendingHandoffRecovery, retryAttempt: number): Promise<void> {
    if (this.#shutdownController.signal.aborted) return Promise.resolve();
    const operationId = recovery.intent.operationId;
    const active = this.#activeRecoveryAttempts.get(operationId);
    if (active) return active;
    if (recovery.step === 'fenced' || this.#recoveryTimers.has(operationId)) {
      return Promise.resolve();
    }
    const attempt = this.#attemptHandoffRecovery(recovery, retryAttempt);
    this.#activeRecoveryAttempts.set(operationId, attempt);
    const clear = () => {
      if (this.#activeRecoveryAttempts.get(operationId) === attempt) {
        this.#activeRecoveryAttempts.delete(operationId);
      }
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  #ensureRecovery(
    intent: AgentHandoffIntent,
    step: HandoffRecoveryStep = 'ledger-boundary',
  ): PendingHandoffRecovery {
    let recovery = this.#recoveries.get(intent.operationId);
    if (!recovery) {
      recovery = { intent, step };
      this.#recoveries.set(intent.operationId, recovery);
    }
    // Existing recovery progress remains authoritative; repeated earlier steps are idempotent.
    return recovery;
  }

  async #attemptHandoffRecovery(
    recovery: PendingHandoffRecovery,
    retryAttempt: number,
  ): Promise<void> {
    const { intent } = recovery;
    const operationId = intent.operationId;
    try {
      while (recovery.step !== 'fenced') {
        if (this.#shutdownController.signal.aborted) return;
        if (this.#recoveries.get(operationId) !== recovery) return;
        switch (recovery.step) {
          case 'ledger-boundary':
            this.deps.ledger.closeProducer(intent.chatId);
            this.#applyLedgerBoundary(intent);
            recovery.step = 'registry';
            break;
          case 'registry':
            if (!this.#hasPendingHandoff(intent)) {
              if (!matchesHandoffTarget(this.deps.registry.getChat(intent.chatId), intent)) {
                logger.warn('Pending handoff recovery stopped after its intent disappeared', {
                  chatId: intent.chatId,
                  operationId: intent.operationId,
                });
                recovery.step = 'fenced';
                return;
              }
              recovery.step = 'producer';
              break;
            }
            await this.deps.ownership.applyHandoffDecision(intent.operationId);
            recovery.step = 'journal';
            break;
          case 'journal':
            await this.#completeHandoffIfPending(intent);
            recovery.step = 'producer';
            break;
          case 'producer':
            await this.deps.reopenProducer(intent.chatId);
            if (this.#recoveries.get(operationId) === recovery) {
              this.#recoveries.delete(operationId);
            }
            await this.#notifyCommitted(intent.chatId);
            return;
        }
      }
    } catch (error) {
      logger.warn('Pending handoff recovery attempt failed', {
        chatId: intent.chatId,
        operationId: intent.operationId,
        attempt: retryAttempt + 1,
        code: error instanceof HandoffBoundaryCorruptionError
          ? 'HANDOFF_BOUNDARY_CORRUPT'
          : 'HANDOFF_RECOVERY_FAILED',
      });
      if (error instanceof HandoffBoundaryCorruptionError) {
        recovery.step = 'fenced';
        return;
      }
      if (this.#shutdownController.signal.aborted) return;
      if (this.#recoveries.get(operationId) !== recovery) return;
      this.#scheduleHandoffRecovery(recovery, retryAttempt);
    }
  }

  async #completeHandoffIfPending(intent: AgentHandoffIntent): Promise<void> {
    if (!this.#hasPendingHandoff(intent)) return;
    try {
      await this.deps.ownership.completeHandoff(intent.operationId);
    } catch (error) {
      if (!this.#hasPendingHandoff(intent)) return;
      throw error;
    }
  }

  #hasPendingHandoff(intent: AgentHandoffIntent): boolean {
    return this.deps.ownership.findHandoff(
      intent.chatId,
      intent.clientRequestId,
    )?.operationId === intent.operationId;
  }

  #disarmHandoffRecovery(operationId: string): void {
    this.#recoveries.delete(operationId);
    const timer = this.#recoveryTimers.get(operationId);
    if (!timer) return;
    clearTimeout(timer);
    this.#recoveryTimers.delete(operationId);
  }

  #scheduleHandoffRecovery(recovery: PendingHandoffRecovery, retryAttempt: number): void {
    const operationId = recovery.intent.operationId;
    if (this.#shutdownController.signal.aborted || this.#recoveryTimers.has(operationId)) return;
    const delay = Math.min(
      MAX_RECOVERY_RETRY_DELAY_MS,
      INITIAL_RECOVERY_RETRY_DELAY_MS * 2 ** retryAttempt,
    );
    const timer = setTimeout(() => {
      if (this.#recoveryTimers.get(operationId) !== timer) return;
      this.#recoveryTimers.delete(operationId);
      if (this.#shutdownController.signal.aborted) return;
      const retry = () => {
        void this.#recoverHandoff(recovery, retryAttempt + 1);
      };
      const active = this.#activeRecoveryAttempts.get(operationId);
      if (active) void active.then(retry, retry);
      else retry();
    }, delay);
    timer.unref?.();
    this.#recoveryTimers.set(operationId, timer);
  }

  #requireUnchangedSource(chatId: string, expected: OwnershipFence): void {
    const current = this.deps.registry.getChat(chatId);
    if (!current) throw new DomainError('CHAT_DELETED', 'The chat was deleted.', 404);
    if (!matchesOwnershipFence(current, expected)) {
      throw new DomainError(
        'STALE_CHAT_OWNERSHIP',
        'The chat owner changed during handoff preparation.',
        409,
      );
    }
  }

  async #notifyCommitted(chatId: string): Promise<void> {
    try {
      await this.deps.onCommitted?.(chatId);
    } catch (error) {
      logger.warn('Post-handoff invalidation failed', {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function assertMatchingHandoff(intent: AgentHandoffIntent, submittedTargetHash: string): void {
  if (intent.submittedTargetHash === submittedTargetHash) return;
  throw new DomainError(
    'IDEMPOTENCY_CONFLICT',
    'clientRequestId was reused with a different handoff target.',
    409,
  );
}

class HandoffBoundaryCorruptionError extends Error {
  override readonly name = 'HandoffBoundaryCorruptionError';

  constructor(chatId: string) {
    super(`Durable agent-switch boundary conflicts with the pending handoff for ${chatId}`);
  }
}

class HandoffStepRetryLimitError extends Error {
  override readonly name = 'HandoffStepRetryLimitError';
  readonly step: HandoffRecoveryStep;

  constructor(label: string, step: HandoffRecoveryStep, cause: unknown) {
    super(`Decided handoff step exceeded its request retry budget: ${label}`, { cause });
    this.step = step;
  }
}

function matchesSwitchMarker(
  marker: LedgerAgentSwitchRow,
  intent: AgentHandoffIntent,
): boolean {
  return marker.detail.fromAgentId === intent.source.agentId
    && marker.detail.toAgentId === intent.target.execution.agentId
    && marker.detail.toModel === (intent.target.execution.model ?? null);
}

async function retryHandoffStep<T>(
  label: string,
  operation: () => T | Promise<T>,
  signal: AbortSignal,
  recoveryStep: HandoffRecoveryStep,
): Promise<T> {
  for (let attempts = 0; ; attempts += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof HandoffBoundaryCorruptionError) throw error;
      logger.warn('Decided handoff step will be retried', {
        label,
        attempts: attempts + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (attempts + 1 === REQUEST_ROLL_FORWARD_ATTEMPTS) {
        throw new HandoffStepRetryLimitError(label, recoveryStep, error);
      }
      await waitForHandoffRetry(Math.min(1_000, 25 * 2 ** attempts), signal);
    }
  }
}

function waitForHandoffRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

interface OwnershipFence {
  readonly agentId: string;
  readonly agentOwnershipEpoch: string;
}

function ownershipFence(entry: ChatRegistryEntry): OwnershipFence {
  return {
    agentId: entry.agentId,
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
  };
}

function matchesOwnershipFence(
  entry: ChatRegistryEntry | null,
  expected: OwnershipFence,
): boolean {
  return entry?.agentId === expected.agentId
    && entry.agentOwnershipEpoch === expected.agentOwnershipEpoch;
}

function cloneRegistryEntry(entry: ChatRegistryEntry): ChatRegistryEntry {
  return structuredClone(entry);
}

function handoffOperationId(chatId: string, clientRequestId: string): string {
  return `agent-handoff:${crypto.createHash('sha256')
    .update(chatId)
    .update('\0')
    .update(clientRequestId)
    .digest('hex')}`;
}

function handoffTargetHash(handoff: AgentHandoffRequest): string {
  return crypto.createHash('sha256').update(stableStringify(handoff.target)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function preferredValue<T extends string>(supported: readonly T[], preferred: T): T {
  return supported.includes(preferred) ? preferred : supported[0] ?? preferred;
}

function assertSupported(values: readonly string[], value: string, label: string): void {
  if (!values.includes(value)) {
    throwUnsupported(value, label);
  }
}

function throwUnsupported(value: string, label: string): never {
  throw new DomainError(
    'VALIDATION_FAILED',
    `The target agent does not support ${label} ${value}.`,
    422,
  );
}

export function resolvedRunOptions(target: ResolvedAgentHandoffTarget): {
  readonly model: string;
  readonly apiProviderId: string | null;
  readonly modelEndpointId: string | null;
  readonly modelProtocol: ResolvedAgentHandoffTarget['modelProtocol'];
  readonly permissionMode: ResolvedAgentHandoffTarget['permissionMode'];
  readonly thinkingMode: ResolvedAgentHandoffTarget['thinkingMode'];
  readonly agentSettings: ResolvedAgentHandoffTarget['agentSettings'];
} {
  return {
    model: target.model,
    apiProviderId: target.apiProviderId,
    modelEndpointId: target.modelEndpointId,
    modelProtocol: target.modelProtocol,
    permissionMode: target.permissionMode,
    thinkingMode: target.thinkingMode,
    agentSettings: target.agentSettings,
  };
}
