import crypto from 'node:crypto';
import type {
  AgentHandoffRequest,
} from '../../common/chat-command-contracts.js';
import type { AgentCatalogEntry } from '../../common/agents.js';
import {
  renderCarriedContext,
  sanitizeRecordedCarriedContext,
} from '../../common/transcript-seed.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { DirectInputPreparationContext } from '../chat-execution/types.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import {
  CarryOverTranscriptError,
  type CarryOverTranscriptStore,
  type PreparedCarryOverSegment,
} from '../chats/carryover-transcript-store.js';
import type {
  CarryOverSegmentRef,
  ChatRegistryEntry,
  IChatRegistry,
} from '../chats/store.js';
import {
  carryOverRevision,
  emptyEraId,
  handoffSegmentId,
  reconcileArchivedTail,
} from '../chats/carryover-segments.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { IntegrationRegistry } from './integration-registry.js';
import { toAgentChatReference } from './integration-chat-reference.js';
import type { ResolvedAgentHandoffTarget } from './agent-handoff-types.js';
import type { SettledNativeCaptureService } from './settled-native-capture.js';

const logger = createLogger('agents:handoff');

export interface AgentHandoffPreparation {
  readonly operation: 'agent-handoff';
  prepare(context: DirectInputPreparationContext): Promise<void>;
  compensate(): Promise<void>;
}

export class AgentHandoffService {
  constructor(private readonly deps: {
    readonly registry: IChatRegistry;
    readonly integrations: IntegrationRegistry;
    readonly endpointResolver: ApiProviderEndpointResolver;
    readonly catalog: {
      getAgentCatalogEntry(agentId: string): Promise<AgentCatalogEntry | null>;
    };
    readonly carryOver: CarryOverTranscriptStore;
    readonly settledCapture: SettledNativeCaptureService;
    readonly ownership: AgentOwnershipJournal;
    readonly onCommitted?: (chatId: string) => void | Promise<void>;
  }) {}

  // Archives a chat's live provider era into immutable segments and returns the
  // refs a continuation should inherit. Shared with `/handoff`, which continues
  // under the same agent in a new chat rather than switching owner in place, so
  // both paths capture the source identically and only differ in what they do
  // with the result. The caller owns the returned handle and must release or
  // discard it, exactly as the in-place handoff does around its commit.
  async captureContinuationSegments(input: {
    readonly chatId: string;
    readonly source: ChatRegistryEntry;
    readonly target: { readonly agentId: string; readonly model: string };
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly segments: readonly CarryOverSegmentRef[];
    readonly prepared: PreparedCarryOverSegment | null;
    // Re-asserts that the provider transcript still matches what was captured.
    // Resolves immediately when the source had no session to capture.
    assertUnchanged(signal: AbortSignal): Promise<void>;
  }> {
    const source = input.source;
    const integration = this.deps.integrations.get(source.agentId);
    if (!integration) {
      throw new DomainError(
        'SOURCE_TRANSCRIPT_UNAVAILABLE',
        'The source agent integration is unavailable.',
        422,
      );
    }
    await this.deps.carryOver.assertAvailable(source.carryOverSegments, input.signal);
    const reference = toAgentChatReference(
      integration,
      input.chatId,
      source,
      this.deps.carryOver.revision(
        source.carryOverSegments,
        source.carryOverMigrationQuarantine,
      ),
    );
    const snapshot = source.agentSessionId
      ? await this.deps.settledCapture.loadStable({
          chatId: input.chatId,
          integration,
          reference,
          signal: input.signal,
        })
      : null;
    const sanitized = sanitizeRecordedCarriedContext({
      messages: snapshot?.messages ?? [],
      receipt: source.nativeSeedReceipt,
      agentSessionId: source.agentSessionId,
    });
    if (sanitized.kind === 'mismatch') {
      throw new DomainError(
        'CONTEXT_ENVELOPE_MISMATCH',
        'The recorded carried-context envelope does not match this native session.',
        422,
      );
    }

    const capturedAt = new Date().toISOString();
    let segments = reconcileArchivedTail(
      source.carryOverSegments,
      { agentId: source.agentId, model: source.model },
      () => emptyEraId(input.chatId, input.operationId),
      capturedAt,
    );
    const segmentId = handoffSegmentId(input.chatId, input.clientRequestId);
    const trailingHandoff = { agentId: input.target.agentId, model: input.target.model };
    let prepared: PreparedCarryOverSegment | null = null;
    if (sanitized.messages.length > 0) {
      prepared = await this.deps.carryOver.prepareSegment({
        operationId: input.operationId,
        id: segmentId,
        seedSanitation: sanitized.kind,
        messages: sanitized.messages,
        signal: input.signal,
      });
      await prepared.commit();
      const ref: CarryOverSegmentRef = {
        id: prepared.id,
        agentId: source.agentId,
        model: source.model,
        capturedAt,
        storedMessageCount: prepared.messageCount,
        visibleMessageCount: prepared.messageCount,
        trailingHandoff,
      };
      segments = [...segments, ref];
      await this.deps.carryOver.verifySegment(ref, input.signal);
    } else if (source.agentSessionId || segments.length > 0) {
      segments = [
        ...segments,
        {
          id: segmentId,
          agentId: source.agentId,
          model: source.model,
          capturedAt,
          storedMessageCount: 0,
          visibleMessageCount: 0,
          trailingHandoff,
        },
      ];
    }
    return {
      segments,
      prepared,
      assertUnchanged: async (signal) => {
        if (!snapshot) return;
        await this.deps.settledCapture.assertRevision({
          integration,
          reference,
          expectedRevision: snapshot.revision,
          signal,
        });
      },
    };
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
    assertCarryOverAvailable(input.chat);
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
    assertSupported(catalog.supportedThinkingModes, thinkingMode, 'reasoning effort');
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
  }): AgentHandoffPreparation {
    const operationId = handoffOperationId(input.chatId, input.clientRequestId);
    const submittedTargetHash = handoffTargetHash(input.handoff);
    const sourceSnapshot = cloneRegistryEntry(input.source);
    const sourceFence = ownershipFence(sourceSnapshot);
    let preparedSegment: PreparedCarryOverSegment | null = null;
    let intentStarted = false;
    let registryCommitted = false;
    let targetFence: OwnershipFence | null = null;

    return {
      operation: 'agent-handoff',
      prepare: async (context) => {
        try {
          assertCarryOverAvailable(sourceSnapshot);
          const existing = this.deps.ownership.findHandoff(input.chatId, input.clientRequestId);
          if (existing) {
            if (existing.submittedTargetHash !== submittedTargetHash) {
              throw new DomainError(
                'IDEMPOTENCY_CONFLICT',
                'clientRequestId was reused with a different handoff target.',
                409,
              );
            }
            intentStarted = true;
            targetFence = {
              agentId: existing.target.execution.agentId,
              agentOwnershipEpoch: existing.target.agentOwnershipEpoch,
              agentSessionId: null,
              carryOverRevision: carryOverRevision(existing.target.carryOverSegments),
            };
            await this.deps.carryOver.assertAvailable(
              existing.target.carryOverSegments,
              context.signal,
            );
            if (existing.target.carryOverSegments.length > 0) {
              const tail = await this.deps.carryOver.loadProjectionSource({
                refs: existing.target.carryOverSegments,
                signal: context.signal,
              });
              renderCarriedContext(tail);
            }
            context.assertAdmissionActive();
            await this.deps.ownership.commitHandoff(
              existing.operationId,
              context.assertAdmissionActive,
            );
            registryCommitted = true;
            await this.#notifyCommitted(input.chatId);
            return;
          }

          this.#requireUnchangedSource(input.chatId, sourceFence);
          const source = sourceSnapshot;
          const captured = await this.captureContinuationSegments({
            chatId: input.chatId,
            source,
            target: { agentId: input.target.agentId, model: input.target.model },
            operationId,
            clientRequestId: input.clientRequestId,
            signal: context.signal,
          });
          preparedSegment = captured.prepared;
          const targetSegments = captured.segments;

          if (targetSegments.length > 0) {
            const tail = await this.deps.carryOver.loadProjectionSource({
              refs: targetSegments,
              signal: context.signal,
            });
            renderCarriedContext(tail);
          }
          const intent = await this.deps.ownership.beginHandoff({
            operationId,
            clientRequestId: input.clientRequestId,
            submittedTargetHash,
            chatId: input.chatId,
            source,
            target: input.target,
            targetCarryOverSegments: targetSegments,
          });
          targetFence = {
            agentId: intent.target.execution.agentId,
            agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
            agentSessionId: null,
            carryOverRevision: carryOverRevision(intent.target.carryOverSegments),
          };
          intentStarted = true;
          await captured.assertUnchanged(context.signal);
          this.#requireUnchangedSource(input.chatId, sourceFence);
          context.assertAdmissionActive();
          await this.deps.ownership.commitHandoff(operationId, context.assertAdmissionActive);
          registryCommitted = true;
          preparedSegment?.releaseRoot();
          await this.#notifyCommitted(input.chatId);
        } catch (error) {
          throw mapCarryOverError(error);
        }
      },
      compensate: async () => {
        if (registryCommitted) {
          preparedSegment?.releaseRoot();
          return;
        }
        if (intentStarted) await this.deps.ownership.compensateHandoff(operationId);
        const current = this.deps.registry.getChat(input.chatId);
        if (targetFence && matchesOwnershipFence(current, targetFence)) {
          registryCommitted = true;
          preparedSegment?.releaseRoot();
          return;
        }
        await preparedSegment?.discard();
      },
    };
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

interface OwnershipFence {
  readonly agentId: string;
  readonly agentOwnershipEpoch: string;
  readonly agentSessionId: string | null;
  readonly carryOverRevision: string;
}

function ownershipFence(entry: ChatRegistryEntry): OwnershipFence {
  return {
    agentId: entry.agentId,
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
    agentSessionId: entry.agentSessionId,
    carryOverRevision: carryOverRevision(
      entry.carryOverSegments,
      entry.carryOverMigrationQuarantine,
    ),
  };
}

function matchesOwnershipFence(
  entry: ChatRegistryEntry | null,
  expected: OwnershipFence,
): boolean {
  return entry?.agentId === expected.agentId
    && entry.agentOwnershipEpoch === expected.agentOwnershipEpoch
    && entry.agentSessionId === expected.agentSessionId
    && carryOverRevision(
      entry.carryOverSegments,
      entry.carryOverMigrationQuarantine,
    ) === expected.carryOverRevision;
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
    throw new DomainError(
      'VALIDATION_FAILED',
      `The target agent does not support ${label} ${value}.`,
      422,
    );
  }
}

function assertCarryOverAvailable(entry: ChatRegistryEntry): void {
  if (!entry.carryOverMigrationQuarantine) return;
  throw new DomainError(
    'CARRYOVER_HISTORY_UNAVAILABLE',
    'Archived chat history is unavailable.',
    422,
    false,
  );
}

function mapCarryOverError(error: unknown): unknown {
  if (error instanceof CarryOverTranscriptError) {
    return new DomainError(
      'INTERNAL_ERROR',
      'The archived chat history could not be prepared.',
      500,
      false,
      { cause: error },
    );
  }
  return error;
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
