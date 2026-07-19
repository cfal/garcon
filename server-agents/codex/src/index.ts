import type { AgentHost } from '@garcon/server-agent-interface';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { CODEX_MODELS } from '@garcon/common/models';
import { LegacyAgentIntegrationBase } from '@garcon/server-agent-common';
import { bindAgentHost } from './config.js';
import { CodexAppServerRuntime } from './agents/codex/app-server/runtime.js';
import { createCodexAgent } from './agents/codex/index.js';

export default class CodexAgentIntegration extends LegacyAgentIntegrationBase {
  static readonly integrationId = 'codex';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    bindAgentHost(host);
    super({
      host,
      agent: createCodexAgent(new CodexAppServerRuntime()),
      descriptor: {
        id: 'codex',
        label: 'Codex',
        icon: null,
        supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
        supportedThinkingModes: THINKING_MODE_VALUES,
        supportsImages: true,
        supportsProjectPathUpdate: true,
        requiresNativePathForProjectPathUpdate: false,
        supportedEndpointProtocols: ['openai-compatible'],
        configuration: [
          { key: 'OPENAI_API_KEY', source: 'environment', description: 'OpenAI API key.' },
          { key: 'OPENAI_BASE_URL', source: 'environment', description: 'OpenAI API base URL.' },
          { key: 'CODEX_HOME', source: 'environment', description: 'Codex state directory.' },
          { key: 'CLAUDE_BINARY', source: 'environment', description: 'Claude CLI compatibility binary.' },
          { key: 'CURSOR_BINARY', source: 'environment', description: 'Cursor CLI compatibility binary.' },
          { key: 'npm_package_version', source: 'environment', description: 'Garcon package version.' },
        ],
      },
      defaultModel: CODEX_MODELS.DEFAULT,
      models: CODEX_MODELS.OPTIONS,
    });
  }
}
