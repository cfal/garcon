import { fileURLToPath } from 'node:url';
import { AssistantMessage } from '../../../../common/chat-types.ts';
import { AcpAgentRuntime } from '../../../../server-agents/common/src/acp/agent-runtime.ts';
import { runtimeOperation, type AgentRuntimeEvent } from '../../../../server-agents/common/src/execution/runtime-events.ts';

const peer = fileURLToPath(new URL('../fixtures/acp-agent-runtime-peer.ts', import.meta.url));
const replies: unknown[] = [];
let buffered = '';
const runtime = new AcpAgentRuntime(
  { agentId: 'synthetic', command: process.execPath, args: [peer] },
  {
    converter: {
      fromSessionUpdate(notification) {
        const update = notification.update as { content?: string } | undefined;
        buffered += update?.content ?? '';
        return [];
      },
      endTurn() {
        if (!buffered) return [];
        const content = buffered;
        buffered = '';
        return [new AssistantMessage('1970-01-01T00:00:00.000Z', content)];
      },
    },
  },
);

const started = Promise.withResolvers<void>();
const publish = (event: AgentRuntimeEvent) => {
  if (event.type === 'rows') replies.push({ event: 'rows', rows: event.rows.map(row => row.message) });
  if (event.type === 'run-ended') {
    replies.push({ event: 'run-ended', runId: event.runId, outcome: event.outcome, finalResponse: event.finalResponse });
    if (event.runId === 'first') started.resolve();
  }
};
const request = {
  chatId: 'chat-1', projectPath: process.cwd(), model: 'default',
  permissionMode: 'default' as const, thinkingMode: 'none' as const,
};
try {
  const session = await runtime.startSession({ ...request, command: 'first', operation: runtimeOperation('first', publish) });
  await started.promise;
  await runtime.runTurn({ ...request, command: 'second', agentSessionId: session.agentSessionId, operation: runtimeOperation('second', publish) });
  console.log(JSON.stringify({ session, replies }));
} finally {
  runtime.shutdown();
}
