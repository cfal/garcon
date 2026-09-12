import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';

export default {
  integrationId: 'claude',
  directories: [
    { path: '.claude', environmentKey: 'CLAUDE_CONFIG_DIR' },
  ],
} as const satisfies AgentNativeEnvironment;
