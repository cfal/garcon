import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { AMP_MODELS } from '@garcon/common/models';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { AmpCliRuntime } from './agents/amp/amp-cli.js';
import { createAmpAgent } from './agents/amp/index.js';

export default class AmpAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'amp';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createAmpAgent(new AmpCliRuntime()),
      descriptor: {
        id: 'amp', label: 'Amp', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: false,
        supportsProjectPathUpdate: false,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: [],
        configuration: [{ key: 'AMP_BINARY', source: 'environment', description: 'Amp CLI binary.' }],
      },
      defaultModel: AMP_MODELS.DEFAULT,
      models: AMP_MODELS.OPTIONS,
      defaultSettings: { ampAgentMode: 'smart' },
    });
  }
}
