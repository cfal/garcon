import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';

export default {
  integrationId: 'cursor',
  directories: [
    { path: '.cursor', environmentKey: null },
  ],
} as const satisfies AgentNativeEnvironment;
