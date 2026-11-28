import { runSingleQuery } from '../../../../server-agents/claude/src/agents/claude/cli-invocation.ts';
import { ClaudeCliVersionProbe } from '../../../../server-agents/claude/src/agents/claude/cli-version.ts';

const [binary, cwd] = process.argv.slice(2);
const noop = () => undefined;
const result = await runSingleQuery('synthetic prompt', {
  model: 'haiku',
  thinkingMode: 'high',
  timeoutMs: 3000,
  cwd,
  envOverrides: { GARCON_SYNTHETIC_QUERY: 'expected' },
}, {
  binary: () => binary,
  versionProbe: new ClaudeCliVersionProbe(),
  logger: { debug: noop, info: noop, warn: noop, error: noop },
});
process.stdout.write(result);
