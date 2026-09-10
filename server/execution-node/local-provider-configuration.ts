import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { normalizePermissionMode } from '@garcon/common/chat-modes';
import { isThinkingModeSupported, normalizeSupportedThinkingMode } from '@garcon/common/execution-defaults';
import type { AgentIntegration, AgentSessionConfiguration } from '@garcon/server-agent-interface';
import type {
  ProviderConfigurationRequest, ProviderConfigurationService,
  ProviderConfigurationUpdate, ProviderConfigurationUpdateRequest,
  ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult,
} from '../execution-nodes/provider-configuration.js';
import { DomainError } from '../lib/domain-error.js';

export class LocalProviderConfigurationService implements ProviderConfigurationService {
  constructor(private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>) {}

  async resolve(input: ProviderConfigurationRequest, signal: AbortSignal): Promise<AgentSessionConfiguration> {
    signal.throwIfAborted();
    const request = structuredClone(input);
    await this.#validateEndpoint(request.endpoint);
    signal.throwIfAborted();
    const permissionMode = normalizePermissionMode(request.permissionMode);
    return structuredClone({
      model: request.model,
      endpoint: request.endpoint,
      permissionMode: this.integration.descriptor.supportedPermissionModes.includes(permissionMode)
        ? permissionMode : 'default',
      thinkingMode: normalizeSupportedThinkingMode(request.thinkingMode, this.integration.descriptor.supportedThinkingModes),
      settings: this.#parseSettings(request.settings),
    });
  }

  async prepareUpdate(input: ProviderConfigurationUpdateRequest, signal: AbortSignal): Promise<ProviderConfigurationUpdate> {
    signal.throwIfAborted();
    const { previous, next, patch } = structuredClone(input);
    await this.#validateEndpoint(next.endpoint);
    signal.throwIfAborted();
    const supportedThinkingModes = this.integration.descriptor.supportedThinkingModes;
    if (patch.thinkingMode !== undefined && !isThinkingModeSupported(patch.thinkingMode, supportedThinkingModes)) {
      throw new DomainError('VALIDATION_FAILED',
        `Thinking mode ${patch.thinkingMode} is not supported by ${this.integration.descriptor.id}`, 422);
    }
    const currentSettings = this.#parseSettings(previous.settings);
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

  async apply(input: ProviderSessionConfigurationRequest, signal: AbortSignal): Promise<ProviderSessionConfigurationResult> {
    signal.throwIfAborted();
    const facet = this.integration.sessionConfiguration;
    if (!facet) return { kind: 'unsupported' };
    const request = structuredClone(input);
    await facet.apply(request.expected.agentSessionId, request.next, request.previous);
    // Cancellation after mutation cannot turn a confirmed local result into a non-delivery claim.
    return { kind: 'applied' };
  }

  #parseSettings(settings: AgentSettingsEnvelope | null): AgentSettingsEnvelope {
    const input = structuredClone(settings ?? this.integration.settings.defaults());
    return structuredClone(this.integration.settings.parse(input));
  }

  async #validateEndpoint(endpoint: AgentEndpointSelection | null): Promise<void> {
    if (!endpoint) return;
    if (!this.integration.endpoints) {
      throw new Error(`Agent integration ${this.integration.descriptor.id} does not accept API provider endpoints`);
    }
    await this.integration.endpoints.validate(structuredClone(endpoint));
  }
}
