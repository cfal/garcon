import { normalizePermissionMode } from '../../../common/chat-modes.js';
import type { PermissionMode, ThinkingMode } from '../../../common/chat-modes.js';
import type { AgentSettingsEnvelope } from '../../../common/agent-integration.js';
import type { AgentSettingsPatchFence } from '../../../common/agent-settings.js';
import type { ExecutorCallOptions } from '@garcon/server-agent-interface';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { AgentChatEntry, AgentSessionSettingsPatch } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import { toAgentEndpointSelection } from './execution-planning.js';
import {
  isThinkingModeSupported,
  normalizeSupportedThinkingMode,
} from '../../../common/execution-defaults.js';
import { DomainError } from '../../common/domain-error.js';
import { interactiveDeadline, readBefore } from '../../common/interactive-deadline.js';
import type { ChatExecutionCommands } from '../chat-execution/types.js';
import { hasPendingTurnInput, type StoredChatExecutionControlState } from '../chat-execution/control-state.js';

export type SettingsExecutionPort = Pick<ChatExecutionCommands,
  | 'reserveTranscriptSnapshot'
  | 'releaseTranscriptSnapshot'
  | 'readChatExecutionControl'
  | 'withChatExecutionControl'
>;

export interface AgentConfigurationInput {
  readonly executorId?: string | null;
  readonly agentId: string;
  readonly model: string;
  readonly apiProviderId?: string | null;
  readonly modelEndpointId?: string | null;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly agentSettings: AgentSettingsEnvelope;
}

export class AgentSessionSettingsService {
  readonly #lock: KeyedPromiseLock;

  constructor(private readonly deps: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    execution: SettingsExecutionPort;
    chatMutationLock?: KeyedPromiseLock;
    onCommitted?: (chatId: string) => void;
  }) {
    this.#lock = deps.chatMutationLock ?? new KeyedPromiseLock();
  }

  async validateConfiguration(input: AgentConfigurationInput, options?: ExecutorCallOptions): Promise<void> {
    const integration = this.deps.directory.require(input.agentId, input.executorId);
    const settings = integration.settings.parse(input.agentSettings);
    const selection = this.deps.endpointResolver.resolveSelection(input);
    if (!integration.configurationValidation) return;
    await integration.configurationValidation.validate({
      model: selection.model,
      permissionMode: normalizePermissionMode(input.permissionMode),
      thinkingMode: normalizeSupportedThinkingMode(
        input.thinkingMode,
        integration.descriptor.supportedThinkingModes,
      ),
      settings,
      endpoint: toAgentEndpointSelection(this.deps.endpointResolver, selection),
    }, options);
    if (this.deps.directory.require(input.agentId, input.executorId) !== integration) throw settingsRefreshRequired();
  }

  updateSessionSettings(
    chatId: string,
    patch: AgentSessionSettingsPatch,
    expectedAgentOwnershipEpoch?: string,
    signal?: AbortSignal,
    settingsFence?: AgentSettingsPatchFence,
  ): Promise<AgentChatEntry> {
    // Starts before the lock, so a change queued behind another gives up in turn.
    const deadline = interactiveDeadline();
    return this.#lock.runExclusive(`chat:${chatId}`, async () => {
      const entry = this.deps.registry.getChat(chatId);
      if (!entry) throw new Error(`Session not found: ${chatId}`);
      if (expectedAgentOwnershipEpoch !== undefined && entry.agentOwnershipEpoch !== expectedAgentOwnershipEpoch) {
        throw new DomainError('STALE_CHAT_OWNERSHIP', 'Chat ownership changed before settings were updated.', 409);
      }
      const integration = this.deps.directory.require(entry.agentId, entry.executorId);
      if (patch.agentSettingsPatch !== undefined && (
        !expectedAgentOwnershipEpoch || !settingsFence
        || settingsFence.expectedExecutorInstanceId !== integration.producers.scope.instanceId
        || settingsFence.expectedSettingsSchemaVersion !== integration.settings.defaults().schemaVersion
      )) throw settingsRefreshRequired();
      const assertCurrent = () => {
        if (this.deps.directory.require(entry.agentId, entry.executorId) !== integration) throw settingsRefreshRequired();
      };
      const currentSettings = integration.settings.parse(
        entry.agentSettingsById[entry.agentId] ?? integration.settings.defaults(),
      );
      const settings = patch.agentSettingsPatch !== undefined
        ? integration.settings.applyPatch(currentSettings, patch.agentSettingsPatch)
        : currentSettings;
      const previous = this.deps.endpointResolver.describePrevious({
        model: entry.model,
        apiProviderId: entry.apiProviderId,
        modelEndpointId: entry.modelEndpointId,
      });
      const next = this.deps.endpointResolver.resolveSelection({
        executorId: entry.executorId,
        agentId: entry.agentId,
        model: patch.model ?? entry.model,
        apiProviderId: patch.apiProviderId !== undefined ? patch.apiProviderId : entry.apiProviderId,
        modelEndpointId: patch.modelEndpointId !== undefined
          ? patch.modelEndpointId
          : entry.modelEndpointId,
      });
      const reservation = integration.literalExecution && previous.model !== next.model
        ? this.deps.execution.reserveTranscriptSnapshot(chatId)
        : null;
      try {
        if (reservation) assertEmptyQueue(await this.deps.execution.readChatExecutionControl(chatId));
        assertCurrent();
        const endpoint = toAgentEndpointSelection(this.deps.endpointResolver, next);
        if (endpoint) {
          if (!integration.endpoints) {
            throw new Error(`Agent integration ${entry.agentId} does not accept API provider endpoints`);
          }
          await integration.endpoints.validate(endpoint, readBefore(deadline, signal));
          assertCurrent();
        }
        assertSameApiProviderBoundary(previous, next);

        const permissionMode = normalizePermissionMode(patch.permissionMode ?? entry.permissionMode);
        if (
          patch.thinkingMode !== undefined
          && !isThinkingModeSupported(
            patch.thinkingMode,
            integration.descriptor.supportedThinkingModes,
          )
        ) {
          throw new DomainError(
            'VALIDATION_FAILED',
            `Thinking mode ${patch.thinkingMode} is not supported by ${entry.agentId}`,
            422,
          );
        }
        const thinkingMode = normalizeSupportedThinkingMode(
          patch.thinkingMode ?? entry.thinkingMode,
          integration.descriptor.supportedThinkingModes,
        );
        const configuration = {
          model: next.model,
          permissionMode,
          thinkingMode,
          settings,
          endpoint,
        };
        await integration.configurationValidation?.validate(configuration, readBefore(deadline, signal));
        assertCurrent();
        this.deps.endpointResolver.resolveEndpointReference(next);
        const commit = async (): Promise<AgentChatEntry> => {
          assertCurrent();
          if (entry.agentSessionId && integration.sessionConfiguration) {
            await integration.sessionConfiguration.apply(
              entry.agentSessionId,
              configuration,
              {
                model: previous.model,
                permissionMode: normalizePermissionMode(entry.permissionMode),
                thinkingMode: normalizeSupportedThinkingMode(
                  entry.thinkingMode,
                  integration.descriptor.supportedThinkingModes,
                ),
                settings: currentSettings,
                endpoint: previous.endpoint ?? null,
              },
              { dispatchDeadline: deadline },
            );
          }

          // A successful native apply remains applied even if its generation retired.
          const updated = await this.deps.registry.updateChat(chatId, {
            model: next.model,
            apiProviderId: next.apiProviderId,
            modelEndpointId: next.endpointId,
            modelProtocol: next.protocol,
            permissionMode,
            thinkingMode,
            ...(patch.agentSettingsPatch === undefined ? {} : { agentSettingsById: {
              ...entry.agentSettingsById,
              [entry.agentId]: settings,
            } }),
          }, { flush: true });
          if (!updated) throw new Error(`Session not found: ${chatId}`);
          this.deps.onCommitted?.(chatId);
          return updated;
        };
        if (!reservation) return await commit();
        return await this.deps.execution.withChatExecutionControl(chatId, async (control) => {
          assertEmptyQueue(control);
          return commit();
        });
      } finally {
        if (reservation) await this.deps.execution.releaseTranscriptSnapshot(reservation);
      }
    });
  }
}

function settingsRefreshRequired(): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Provider settings changed. Refresh the executor catalog before editing settings.', 422);
}

function assertEmptyQueue(control: StoredChatExecutionControlState): void {
  if (hasPendingTurnInput(control)) {
    throw new DomainError('SESSION_BUSY', 'Cannot change execution mode with queued input.', 409);
  }
}
