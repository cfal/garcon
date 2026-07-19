import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { PI_MODELS } from '@garcon/common/models';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { createPiAgent } from './agents/pi/index.js';
import { LazyPiRuntime } from './agents/pi/lazy-runtime.js';

export default class PiAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'pi';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createPiAgent(new LazyPiRuntime()),
      descriptor: {
        id: 'pi', label: 'Pi', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: false,
        supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: true,
        supportedEndpointProtocols: [],
        configuration: [
          { key: 'GARCON_PI_BINARY', source: 'environment', description: 'Garcon Pi CLI binary.' },
          { key: 'PI_BINARY', source: 'environment', description: 'Pi CLI binary.' },
          { key: 'PI_CODING_AGENT_SESSION_DIR', source: 'environment', description: 'Pi session directory.' },
          { key: 'HOME', source: 'environment', description: 'User home directory.' },
          { key: 'NODE_ENV', source: 'environment', description: 'Runtime environment.' },
        ],
      },
      defaultModel: PI_MODELS.DEFAULT,
      generation: null,
      models: PI_MODELS.OPTIONS,
    });
  }
}
