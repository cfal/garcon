import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readWorkerCliOptions } from '../../worker-cli.js';
import { getAmpAuthStatus } from '../../../../server-agents/amp/src/agents/amp/amp-auth.js';
import { runSingleQuery as ampQuery } from '../../../../server-agents/amp/src/agents/amp/amp-cli.js';
import { getClaudeAuthStatus } from '../../../../server-agents/claude/src/agents/claude/claude-auth.js';
import { ClaudeCliVersionProbe } from '../../../../server-agents/claude/src/agents/claude/cli-version.js';
import { getCursorAuthStatus } from '../../../../server-agents/cursor/src/agents/cursor/cursor-auth.js';
import { runSingleQuery as codexQuery } from '../../../../server-agents/codex/src/agents/codex/app-server/run-single-query.js';
import CodexAgentIntegration from '../../../../server-agents/codex/src/index.js';
import { runGh } from '../../../runtime/gh/run.js';
import type { AgentHost } from '@garcon/server-agent-interface';

const root = process.argv[2]!;
assert.ok(process.env.GARCON_CONTROLLER_URL);
await readWorkerCliOptions(['--config-dir', root]);
assert.equal(process.env.GARCON_CONTROLLER_URL, undefined);

const binary = () => join(root, 'provider');
assert.equal((await getAmpAuthStatus({ binary })).authenticated, true);
assert.equal(await ampQuery('synthetic', {}, { binary }), 'synthetic');
assert.equal((await getClaudeAuthStatus({
  binary, anthropicApiKey: () => null, anthropicBaseUrl: () => null, configHomeDir: () => root,
})).authenticated, true);
await new ClaudeCliVersionProbe().assertCompatible(binary());
assert.equal((await getCursorAuthStatus({ binary, apiKey: () => null })).authenticated, true);
assert.equal(await codexQuery('synthetic'), 'synthetic');
assert.equal((await runGh(root, ['probe'])).stdout.trim(), 'synthetic');

const noop = () => {};
const host = {
  agentId: 'codex',
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  storage: {
    rootDirectory: root,
    directory: async () => root,
    claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
  },
  environment: { get: (name: string) => name === 'CODEX_HOME' ? root : undefined },
  apiProviders: { resolveCredential: async () => null },
} satisfies AgentHost;
const integration = new CodexAgentIntegration(host);
await integration.lifecycle.start();
try {
  const login = await integration.auth.launchLogin();
  assert.equal(login.deviceAuth?.code, 'AAAA-BBBB');
} finally {
  await integration.lifecycle.stop();
}
