import type { AgentAuthStatus } from '@garcon/common/agent-execution';
import { CliLoginController } from '@garcon/server-agent-common/auth/cli-login-controller';
import type { AgentIntegration, AgentLogger } from '@garcon/server-agent-interface';
import type { AntigravityConfig } from '../../config.js';
import {
  antigravityLoginCommand, antigravityLoginEnvironment, createAntigravityProbes,
  getAntigravityAuthStatus, validateAntigravityLoginCode,
} from './antigravity-auth.js';
import { createAntigravityCatalog } from './antigravity-models.js';

type ProbeGeneration = ReturnType<typeof createAntigravityProbes> & { lastProbed: AgentAuthStatus | null };

export function createAntigravityAccount(config: AntigravityConfig, logger: AgentLogger) {
  function createProbeGeneration(): ProbeGeneration {
    return { ...createAntigravityProbes(config), lastProbed: null };
  }
  let probes = createProbeGeneration();
  const login = new CliLoginController({
    command: () => antigravityLoginCommand(config),
    mode: 'browser-code',
    logger,
    environment: () => antigravityLoginEnvironment(config),
    validateCode: validateAntigravityLoginCode,
    onSucceeded: () => {
      probes = createProbeGeneration();
    },
  });
  const auth = {
    async status(signal) {
      const signInRunning = login.status().state === 'running';
      const current = probes;
      const status = await getAntigravityAuthStatus(config, { ...current, signal, signInRunning });
      if (!signInRunning) current.lastProbed = status;
      return status;
    },
    launchLogin: () => login.launch(),
    completeLogin: (sessionId, code) => login.complete(sessionId, code),
    loginStatus: async (expectedSessionId) => login.status(expectedSessionId),
  } satisfies NonNullable<AgentIntegration['auth']>;
  return { catalog: createAntigravityCatalog(() => probes.runModels(), logger), auth, stop: () => login.stop() };
}
