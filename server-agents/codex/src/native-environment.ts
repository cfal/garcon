import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';

export default {
  integrationId: 'codex',
  directories: [
    { path: '.codex', environmentKey: 'CODEX_HOME' },
  ],
} as const satisfies AgentNativeEnvironment;
