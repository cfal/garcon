import { CliLoginController } from '@garcon/server-agent-common/auth/cli-login-controller';
import type { AgentIntegration, AgentLogger } from '@garcon/server-agent-interface';
import { classifyAntigravityLaunchError, type AntigravityConfig } from '../../config.js';
import {
  antigravityLoginCommand, antigravityLoginEnvironment, createAntigravityProbes,
  getAntigravityAuthStatus, validateAntigravityLoginCode,
} from './antigravity-auth.js';
import { createAntigravityCatalog } from './antigravity-models.js';

export function createAntigravityAccount(config: AntigravityConfig, logger: AgentLogger) {
  let probes = createAntigravityProbes(config);
  const login = new CliLoginController({
    command: () => antigravityLoginCommand(config),
    mode: 'browser-code',
    logger,
    environment: () => antigravityLoginEnvironment(config),
    validateCode: validateAntigravityLoginCode,
    onSucceeded: () => {
      probes = createAntigravityProbes(config);
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
    launchLogin: () => login.launch().catch(error => { throw classifyAntigravityLaunchError(error); }),
    completeLogin: (sessionId, code) => login.complete(sessionId, code),
    loginStatus: async (expectedSessionId) => login.status(expectedSessionId),
  } satisfies NonNullable<AgentIntegration['auth']>;
  return { catalog: createAntigravityCatalog(() => probes.listModels(), logger), auth, stop: () => login.stop() };
}
