import { getClaudeAuthStatus } from '../../../../server-agents/claude/src/agents/claude/claude-auth.ts';

const [binary, baseUrl, apiKey] = process.argv.slice(2);
const status = await getClaudeAuthStatus({
  binary: () => binary,
  anthropicBaseUrl: () => baseUrl || null,
  anthropicApiKey: () => apiKey || null,
  configHomeDir: () => null,
});
process.stdout.write(JSON.stringify(status));
