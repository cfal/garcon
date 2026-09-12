import type { AgentNativeEnvironment } from '@garcon/server-agent-interface';

export default {
  integrationId: 'pi',
  directories: [
    { path: '.pi/agent', environmentKey: 'PI_CODING_AGENT_DIR' },
    { path: '.pi/agent/sessions', environmentKey: 'PI_CODING_AGENT_SESSION_DIR' },
  ],
} as const satisfies AgentNativeEnvironment;
