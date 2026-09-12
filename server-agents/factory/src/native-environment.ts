import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';

export default {
  integrationId: 'factory',
  directories: [
    { path: '.', environmentKey: 'FACTORY_HOME_OVERRIDE' },
    { path: '.factory', environmentKey: null },
  ],
} as const satisfies AgentNativeEnvironment;
