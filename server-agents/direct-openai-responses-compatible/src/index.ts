import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { MutableApiProviderReader } from '@garcon/server-agent-common/legacy/mutable-api-provider-reader';
import { createDirectOpenAiResponsesAgent } from './legacy-agent.js';

export default class DirectOpenAiResponsesCompatibleIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'direct-openai-responses-compatible';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    const reader = new MutableApiProviderReader();
    super({
      host,
      agent: createDirectOpenAiResponsesAgent(reader, host.storage.rootDirectory),
      descriptor: {
        id: 'direct-openai-responses-compatible', label: 'OpenAI Responses Compatible', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: true, supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: ['openai-compatible'], configuration: [],
      },
      defaultModel: '',
      generation: { priority: 40 },
      onEndpointSelection: (selection, credential) => reader.register(selection, credential),
    });
  }
}
