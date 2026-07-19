import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { FACTORY_MODELS } from '@garcon/common/models';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { FactoryCliRuntime } from './agents/factory/factory-cli.js';
import { createFactoryAgent } from './agents/factory/index.js';

export default class FactoryAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'factory';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createFactoryAgent(new FactoryCliRuntime()),
      descriptor: {
        id: 'factory', label: 'Factory', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: false,
        supportsProjectPathUpdate: false,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: [],
        configuration: [
          { key: 'FACTORY_BINARY', source: 'environment', description: 'Factory Droid CLI binary.' },
          { key: 'FACTORY_API_KEY', source: 'environment', description: 'Factory API key.' },
        ],
      },
      defaultModel: FACTORY_MODELS.DEFAULT,
      models: FACTORY_MODELS.OPTIONS,
    });
  }
}
