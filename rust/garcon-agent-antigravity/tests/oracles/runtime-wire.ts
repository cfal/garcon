import { AcpAgentRuntime } from '../../../../server-agents/common/src/acp/agent-runtime.ts';
import { runtimeOperation, type AgentRuntimeEvent } from '../../../../server-agents/common/src/execution/runtime-events.ts';
import { AntigravityAcpEventConverter } from '../../../../server-agents/antigravity/src/agents/antigravity/antigravity-acp-event-converter.ts';
import { createAntigravityAcpPolicy } from '../../../../server-agents/antigravity/src/agents/antigravity/antigravity-acp-policy.ts';

const [binary, projectPath] = process.argv.slice(2);
if (!binary || !projectPath) throw new Error('Expected the fake agy path and project path.');
const runtime = new AcpAgentRuntime(createAntigravityAcpPolicy({
  binary: () => binary,
  apiKey: () => null,
  authMethod: () => 'oauth-personal',
}), { converter: new AntigravityAcpEventConverter() });
const output: unknown[] = [];
const first = Promise.withResolvers<void>();
const publish = (event: AgentRuntimeEvent) => {
  if (event.type === 'rows') {
    for (const row of event.rows) {
      const { timestamp: _, ...message } = row.message;
      output.push(message);
    }
  }
  if (event.type === 'run-ended') {
    output.push({ runId: event.runId, outcome: event.outcome, finalResponse: event.finalResponse, error: event.error });
    if (event.runId === 'first') first.resolve();
  }
};
const request = {
  chatId: 'chat-1', projectPath, model: 'default', permissionMode: 'default' as const, thinkingMode: 'none' as const,
};
try {
  const session = await runtime.startSession({
    ...request, command: 'First.', operation: runtimeOperation('first', publish),
  });
  await first.promise;
  runtime.releaseSession(request.chatId, session.agentSessionId);
  await runtime.runTurn({
    ...request, agentSessionId: session.agentSessionId,
    command: 'upstream-error', operation: runtimeOperation('second', publish),
  }).catch(() => {});
  console.log(JSON.stringify({ session, output }));
} finally {
  runtime.shutdown();
}
