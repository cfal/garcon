import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { MutableApiProviderReader } from '@garcon/server-agent-common/legacy/mutable-api-provider-reader';
import { createDirectOpenAiChatAgent } from './legacy-agent.js';

export default class DirectOpenAiCompatibleIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'direct-openai-compatible';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    const reader = new MutableApiProviderReader();
    super({
      host,
      agent: createDirectOpenAiChatAgent(reader, host.storage.rootDirectory),
      descriptor: {
        id: 'direct-openai-compatible', label: 'OpenAI Compatible', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: true, supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: ['openai-compatible'], configuration: [],
      },
      defaultModel: '',
      onEndpointSelection: (selection, credential) => reader.register(selection, credential),
    });
  }
}
