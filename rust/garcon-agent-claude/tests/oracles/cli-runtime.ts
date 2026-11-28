import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntimeEvent } from '../../../../server-agents/common/src/execution/runtime-events.ts';
import { ClaudeCliRuntime } from '../../../../server-agents/claude/src/agents/claude/claude-cli.ts';
import { ClaudeCliVersionProbe } from '../../../../server-agents/claude/src/agents/claude/cli-version.ts';

const [binary, projectPath] = process.argv.slice(2);
const noop = () => undefined;
const runtime = new ClaudeCliRuntime({
  binary: () => binary,
  versionProbe: new ClaudeCliVersionProbe(),
  logger: { debug: noop, info: noop, warn: noop, error: noop },
});
const completed: unknown[] = [];
const publish = (event: AgentRuntimeEvent) => {
  if (event.type === 'run-ended') {
    completed.push({
      runId: event.runId,
      outcome: event.outcome,
      finalResponse: event.outcome === 'finished' ? event.finalResponse ?? null : null,
    });
  }
};
const common = {
  chatId: 'synthetic-chat', agentSessionId: 'synthetic-session', projectPath,
  model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
} as const;
const promptLog = join(projectPath, 'prompt-frames');

try {
  await runtime.startClaudeCliSession({
    ...common,
    command: 'synthetic first prompt',
    operation: { runId: 'first-run', publish },
    executionAdmission: {
      signal: new AbortController().signal,
      async markStarted() {
        if (existsSync(promptLog)) throw new Error('Prompt sent before admission');
      },
    },
  });
  await runtime.runClaudeTurn({
    ...common,
    command: 'synthetic second prompt',
    operation: { runId: 'second-run', publish },
  });
  const frames = (await Bun.file(promptLog).text()).trimEnd().split('\n').map((line) => {
    const { uuid: _, ...frame } = JSON.parse(line) as Record<string, unknown>;
    return frame;
  });
  const starts = await Bun.file(join(projectPath, 'process-starts')).text();
  process.stdout.write(JSON.stringify({ frames, completed, starts }));
} finally {
  await runtime.shutdown();
}
