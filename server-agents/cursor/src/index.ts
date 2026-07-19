import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { createCursorAgent } from './agents/cursor/index.js';

export default class CursorAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'cursor';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createCursorAgent({}),
      descriptor: {
        id: 'cursor', label: 'Cursor', icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: false,
        supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: [],
        configuration: [
          { key: 'GARCON_CURSOR_BINARY', source: 'environment', description: 'Garcon Cursor CLI binary.' },
          { key: 'CURSOR_BINARY', source: 'environment', description: 'Cursor CLI binary.' },
          { key: 'CURSOR_API_KEY', source: 'environment', description: 'Cursor API key.' },
        ],
      },
      defaultModel: '',
      generation: null,
    });
  }
}
