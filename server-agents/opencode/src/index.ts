import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { OpenCodeRuntime } from './agents/opencode/opencode.js';
import { createOpenCodeAgent } from './agents/opencode/index.js';

export default class OpenCodeAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'opencode';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createOpenCodeAgent(new OpenCodeRuntime()),
      descriptor: {
        id: 'opencode', label: 'OpenCode', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: false,
        supportsProjectPathUpdate: false,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: [],
        configuration: [{ key: 'NODE_ENV', source: 'environment', description: 'Runtime environment.' }],
      },
      defaultModel: '',
      generation: { priority: 60 },
    });
  }
}
