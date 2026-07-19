import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { CLAUDE_MODELS } from '@garcon/common/models';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { ClaudeCliRuntime } from './agents/claude/claude-cli.js';
import { createClaudeAgent } from './agents/claude/index.js';

export default class ClaudeAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'claude';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createClaudeAgent(new ClaudeCliRuntime()),
      descriptor: {
        id: 'claude',
        label: 'Claude',
        icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES,
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: true,
        supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: ['anthropic-messages'],
        configuration: [
          { key: 'CLAUDE_BINARY', source: 'environment', description: 'Claude CLI binary.' },
          { key: 'CURSOR_BINARY', source: 'environment', description: 'Cursor CLI compatibility binary.' },
          { key: 'ANTHROPIC_API_KEY', source: 'environment', description: 'Anthropic API key.' },
          { key: 'ANTHROPIC_BASE_URL', source: 'environment', description: 'Anthropic API base URL.' },
        ],
      },
      defaultModel: CLAUDE_MODELS.DEFAULT,
      models: CLAUDE_MODELS.OPTIONS,
      defaultSettings: { claudeThinkingMode: 'auto' },
    });
  }
}
