import ClaudeAgentIntegration from '../../../../server-agents/claude/src/index.ts';
import type { AgentHost } from '../../../../server-agents/interface/src/contracts/host.ts';

const unexpectedUse = () => { throw new Error('Unexpected host operation'); };
const host = {
  agentId: 'claude',
  scope: { executorId: 'synthetic-executor', instanceId: 'synthetic-instance', integrationId: 'claude' },
  migrations: { getVersion: unexpectedUse, read: unexpectedUse, commit: unexpectedUse },
  logger: { debug: unexpectedUse, info: unexpectedUse, warn: unexpectedUse, error: unexpectedUse },
  storage: {
    rootDirectory: '/synthetic',
    directory: unexpectedUse,
    claimLegacyWorkspaceDirectory: unexpectedUse,
  },
  environment: { get: unexpectedUse },
  apiProviders: { resolveCredential: unexpectedUse },
} satisfies AgentHost;
const { catalog, descriptor, settings } = new ClaudeAgentIntegration(host);
const defaults = settings.defaults();
const invalid = (() => {
  try {
    settings.applyPatch(defaults, { claudeThinkingMode: 'invalid-mode' });
    throw new Error('Invalid setting accepted');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    return { code: error.code, message: error.message };
  }
})();
process.stdout.write(JSON.stringify({
  descriptor,
  models: await catalog.snapshot({ strict: true, signal: new AbortController().signal }),
  defaults,
  settings: settings.describe(),
  patched: settings.applyPatch(defaults, { claudeThinkingMode: 'off' }),
  invalid,
}));
