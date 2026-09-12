import { isDeepStrictEqual } from 'node:util';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { sameExecutionOwner } from '../../common/execution-location.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { AgentChatEntry, AgentSessionSettingsPatch } from './session-types.js';
import type { AgentInstanceDirectory } from './instance-directory.js';
import { toAgentEndpointSelection } from './execution-planning.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderSessionConfigurationOperation } from '../execution-nodes/provider-configuration.js';

export class AgentSessionSettingsService {
  readonly #lock: KeyedPromiseLock;

  constructor(private readonly deps: {
    registry: IChatRegistry;
    instances: Pick<AgentInstanceDirectory, 'assertAvailableFor' | 'configurationFor'>;
    endpointResolver: ApiProviderEndpointResolver;
    chatMutationLock?: KeyedPromiseLock;
  }) {
    this.#lock = deps.chatMutationLock ?? new KeyedPromiseLock();
  }

  updateSessionSettings(
    chatId: string,
    input: AgentSessionSettingsPatch,
  ): Promise<AgentChatEntry> {
    const patch = structuredClone(input);
    return this.#lock.runExclusive(`chat:${chatId}`, async () => {
      const entry = structuredClone(this.deps.registry.getChat(chatId));
      if (!entry) throw new Error(`Session not found: ${chatId}`);
      const configurationService = this.deps.instances.configurationFor(entry);
      const previous = this.deps.endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: entry.model,
        apiProviderId: entry.apiProviderId,
        modelEndpointId: entry.modelEndpointId,
      });
      const next = this.deps.endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: patch.model ?? entry.model,
        apiProviderId: patch.apiProviderId !== undefined ? patch.apiProviderId : entry.apiProviderId,
        modelEndpointId: patch.modelEndpointId !== undefined
          ? patch.modelEndpointId
          : entry.modelEndpointId,
      });
      assertSameApiProviderBoundary(previous, next);
      const configuration = await configurationService.prepareUpdate({
        previous: {
          model: previous.model,
          permissionMode: entry.permissionMode,
          thinkingMode: entry.thinkingMode,
          settings: entry.agentSettingsById[entry.agentId] ?? null,
          endpoint: toAgentEndpointSelection(this.deps.endpointResolver, previous),
        },
        next: { model: next.model, endpoint: toAgentEndpointSelection(this.deps.endpointResolver, next) },
        patch: {
          permissionMode: patch.permissionMode,
          thinkingMode: patch.thinkingMode,
          settings: patch.agentSettingsPatch,
        },
      }, new AbortController().signal).catch(configurationPreparationFailed);
      this.#assertCurrentTarget(chatId, entry);

      let operation: ProviderSessionConfigurationOperation | null = null;
      let applied = false;
      const controller = new AbortController();
      try {
        if (entry.agentSessionId) {
          const prepared = await configurationService.prepareApply({
            executionLocation: entry.executionLocation,
            expected: {
              chatId,
              agentSessionId: entry.agentSessionId,
              nativeSession: entry.nativeSession ?? null,
              projectPath: entry.projectPath,
            },
            next: configuration.next,
            previous: configuration.previous,
          }, controller.signal).catch(configurationPreparationFailed);
          if (prepared.kind === 'prepared') operation = prepared.operation;
          if (prepared.kind === 'rejected') throw configurationTargetChanged();
          this.#assertCurrentTarget(chatId, entry);
          if (operation) {
            const result = await configurationService.commit(operation, controller.signal);
            if (result.kind === 'rejected') throw configurationTargetChanged();
            if (result.kind === 'unknown') {
              throw new DomainError('SESSION_SETTINGS_OUTCOME_UNKNOWN',
                'The agent did not confirm the settings update; saved settings are unchanged', 504);
            }
            applied = result.kind === 'applied';
            this.#assertCurrentTarget(chatId, entry);
          }
        }

        const { model, permissionMode, thinkingMode, settings } = configuration.next;
        const updated = await this.deps.registry.updateChat(chatId, {
          model,
          apiProviderId: next.apiProviderId,
          modelEndpointId: next.endpointId,
          modelProtocol: next.protocol,
          permissionMode,
          thinkingMode,
          agentSettingsById: {
            ...entry.agentSettingsById,
            [entry.agentId]: settings,
          },
        }, { flush: true });
        if (!updated) throw new Error(`Session not found: ${chatId}`);
        return updated;
      } catch (error) {
        if (!applied) throw error;
        throw new DomainError('SESSION_SETTINGS_PARTIAL',
          'The agent applied the settings, but saving them could not be confirmed. Refresh the chat before continuing.',
          error instanceof DomainError && error.code === 'SOURCE_REVISION_CHANGED' ? 409 : 500, false, { cause: error });
      } finally {
        controller.abort();
        if (operation) await configurationService.cancel(operation);
      }
    });
  }

  #assertCurrentTarget(chatId: string, expected: AgentChatEntry): void {
    const current = this.deps.registry.getChat(chatId);
    if (!current || !sameExecutionOwner(current, expected)
      || current.agentOwnershipEpoch !== expected.agentOwnershipEpoch
      || current.agentSessionId !== expected.agentSessionId
      || current.projectPath !== expected.projectPath
      || !isDeepStrictEqual(current.nativeSession, expected.nativeSession)) {
      throw new DomainError('SOURCE_REVISION_CHANGED', 'Session changed while updating settings', 409);
    }
    this.deps.instances.assertAvailableFor(current);
  }
}

function configurationTargetChanged(): DomainError {
  return new DomainError('SESSION_SETTINGS_TARGET_CHANGED', 'The agent session changed before the settings update was delivered', 409);
}

function configurationPreparationFailed(error: unknown): never {
  if (error instanceof AgentIntegrationError) {
    if (error.code === 'SESSION_BUSY') {
      throw new DomainError(error.code, error.message, 409, error.retryable, { cause: error });
    }
    if (error.code === 'OPERATION_UNSUPPORTED') {
      throw new DomainError(error.code, error.message, 422, error.retryable, { cause: error });
    }
    if (error.code === 'INVALID_SETTINGS' || error.code === 'INVALID_ENDPOINT') {
      throw new DomainError('VALIDATION_FAILED', error.message, 422, error.retryable, { cause: error });
    }
  }
  throw error;
}
