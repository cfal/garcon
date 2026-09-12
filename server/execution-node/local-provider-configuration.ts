import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { normalizePermissionMode } from '@garcon/common/chat-modes';
import { isThinkingModeSupported, normalizeSupportedThinkingMode } from '@garcon/common/execution-defaults';
import type { AgentIntegration, AgentPreparedProviderConfiguration, AgentSessionConfigurationTarget,
  AgentSessionConfigurationUpdates } from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type {
  ProviderConfigurationRequest, ProviderConfigurationResolver, ProviderConfigurationService,
  ProviderConfigurationUpdate, ProviderConfigurationUpdateRequest,
  ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult,
  ProviderSessionConfigurationOperation, ProviderSessionConfigurationPreparation,
} from '../execution-nodes/provider-configuration.js';
import { DomainError } from '../lib/domain-error.js';
import { assertNativeChatOwner } from './local-native-chat-reference.js';

interface PendingConfiguration {
  readonly facet: AgentSessionConfigurationUpdates;
  readonly target: AgentSessionConfigurationTarget;
  readonly signal: AbortSignal;
}

export class LocalProviderConfigurationService implements ProviderConfigurationResolver, ProviderConfigurationService {
  readonly #pending = new WeakMap<ProviderSessionConfigurationOperation, PendingConfiguration>();
  constructor(private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>) {}

  async resolve(input: ProviderConfigurationRequest, signal: AbortSignal): Promise<AgentPreparedProviderConfiguration> {
    signal.throwIfAborted();
    const request = structuredClone(input);
    const settings = structuredClone(request.settings ?? this.integration.settings.defaults());
    await this.#validateEndpoint(request.endpoint?.selection ?? null);
    signal.throwIfAborted();
    const permissionMode = normalizePermissionMode(request.permissionMode);
    return structuredClone({
      model: request.model,
      endpoint: request.endpoint,
      permissionMode: this.integration.descriptor.supportedPermissionModes.includes(permissionMode)
        ? permissionMode : 'default',
      thinkingMode: normalizeSupportedThinkingMode(request.thinkingMode, this.integration.descriptor.supportedThinkingModes),
      settings: this.#parseSettings(settings),
    });
  }

  async prepareUpdate(input: ProviderConfigurationUpdateRequest, signal: AbortSignal): Promise<ProviderConfigurationUpdate> {
    signal.throwIfAborted();
    const { previous, next, patch } = structuredClone(input);
    const capturedSettings = structuredClone(previous.settings ?? this.integration.settings.defaults());
    await this.#validateEndpoint(next.endpoint);
    signal.throwIfAborted();
    const supportedThinkingModes = this.integration.descriptor.supportedThinkingModes;
    if (patch.thinkingMode !== undefined && !isThinkingModeSupported(patch.thinkingMode, supportedThinkingModes)) {
      throw new DomainError('VALIDATION_FAILED',
        `Thinking mode ${patch.thinkingMode} is not supported by ${this.integration.descriptor.id}`, 422);
    }
    const currentSettings = this.#parseSettings(capturedSettings);
    const settings = patch.settings
      ? this.integration.settings.applyPatch(structuredClone(currentSettings), patch.settings)
      : currentSettings;
    return structuredClone({
      previous: {
        model: previous.model,
        endpoint: previous.endpoint,
        permissionMode: normalizePermissionMode(previous.permissionMode),
        thinkingMode: normalizeSupportedThinkingMode(previous.thinkingMode, supportedThinkingModes),
        settings: currentSettings,
      },
      next: {
        model: next.model,
        endpoint: next.endpoint,
        permissionMode: normalizePermissionMode(patch.permissionMode ?? previous.permissionMode),
        thinkingMode: normalizeSupportedThinkingMode(patch.thinkingMode ?? previous.thinkingMode, supportedThinkingModes),
        settings,
      },
    });
  }

  async prepareApply(input: ProviderSessionConfigurationRequest, signal: AbortSignal): Promise<ProviderSessionConfigurationPreparation> {
    signal.throwIfAborted();
    const facet = this.integration.sessionConfiguration;
    if (!facet) return { kind: 'unsupported' };
    const request = structuredClone(input);
    assertNativeChatOwner(this.integration, { agentId: this.integration.descriptor.id, nativeSession: request.expected.nativeSession });
    const result = await facet.prepare({ expected: request.expected, previous: request.previous, next: request.next, signal });
    if (result.kind !== 'prepared') return result;
    const operation = Object.freeze({}) as ProviderSessionConfigurationOperation;
    this.#pending.set(operation, { facet, target: result.target, signal });
    return { kind: 'prepared', operation };
  }

  async commit(operation: ProviderSessionConfigurationOperation, signal: AbortSignal): Promise<ProviderSessionConfigurationResult> {
    const pending = this.#pending.get(operation);
    if (!pending) return { kind: 'rejected', reason: 'target-changed' };
    this.#pending.delete(operation);
    if (signal.aborted || pending.signal.aborted) {
      pending.facet.cancel(pending.target);
      return { kind: 'rejected', reason: 'cancelled' };
    }
    try {
      return await pending.facet.commit(pending.target, AbortSignal.any([pending.signal, signal]));
    } catch {
      return { kind: 'unknown' };
    }
  }

  async cancel(operation: ProviderSessionConfigurationOperation): Promise<void> {
    const pending = this.#pending.get(operation);
    if (!pending) return;
    this.#pending.delete(operation);
    pending.facet.cancel(pending.target);
  }

  #parseSettings(settings: AgentSettingsEnvelope): AgentSettingsEnvelope {
    const input = structuredClone(settings);
    return structuredClone(this.integration.settings.parse(input));
  }

  async #validateEndpoint(endpoint: AgentEndpointSelection | null): Promise<void> {
    if (!endpoint) return;
    if (!this.integration.endpoints) {
      throw new AgentIntegrationError('INVALID_ENDPOINT', `Agent integration ${this.integration.descriptor.id} does not accept API provider endpoints`, false);
    }
    await this.integration.endpoints.validate(structuredClone(endpoint));
  }
}
