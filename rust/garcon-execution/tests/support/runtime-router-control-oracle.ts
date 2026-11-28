import { AgentCallError } from '../../../../server-agents/interface/src/index.ts';
import { ExecutorSessionLostError } from '../../../../server/common/executor-disconnect.ts';
import { AgentRuntimeRouter } from '../../../../server/controller/agents/runtime-router.ts';
import { createRuntimeTranscriptFixture } from '../../../../server/controller/agents/__tests__/runtime-router-test-fixture.js';
import { permissionResponse } from '../../../../server/controller/agents/__tests__/producer-fixture.ts';

const CHAT = 'chat-1';
const OCCURRENCE = 'incarnation-1';
const REMOTE = 'executor-a';
const control = () => ({ serverInstanceId: 'server-1', chatId: CHAT, runId: 'run-1', permissionOccurrenceId: OCCURRENCE });
const entry = { agentId: 'test', executorId: REMOTE, agentSessionId: 'session-1', projectPath: '/repo', model: 'model' };
const decision = { allow: true };

async function result(run: () => unknown) {
  try { return await run() ?? null; }
  catch (error) {
    const typed = error as Error & { code?: string; outcome?: string };
    return { error: typed.message, code: typed.code ?? null, outcome: typed.outcome ?? null };
  }
}

export async function routerPermissionTrace(mode: string) {
  const effects: unknown[] = [];
  const response = { ...permissionResponse(OCCURRENCE), executorId: mode === 'wrong-target' ? 'executor-b' : REMOTE };
  const transcript = createRuntimeTranscriptFixture({
    permissionDecision: { permissionOccurrenceId: OCCURRENCE, response },
    onPermissionClaim: (claim) => { effects.push(['claim', claim.permissionOccurrenceId]); },
    onPermissionAbandoned: (claim) => { effects.push(['abandon', claim.permissionOccurrenceId]); },
    onPermissionRetired: (claim) => { effects.push(['retire', claim.permissionOccurrenceId]); },
    onPermissionResolved: (claim, decision) => { effects.push(['complete', claim.permissionOccurrenceId, decision]); },
  });
  const router = new AgentRuntimeRouter({
    registry: { getChat: () => mode === 'missing-chat' ? null : entry },
    directory: { require(agentId, executorId) {
      effects.push(['require', agentId, executorId]);
      if (mode === 'lookup-failure') throw new Error('Executor unavailable');
      return { permissions: {
        async respond({ response, decision }, options) {
          effects.push(['respond', response.id, response.executorId, decision, options.dispatchDeadline]);
          if (mode === 'lost') throw new ExecutorSessionLostError('not-dispatched', 'Connection lost');
          if (mode === 'not-dispatched' || mode === 'rejected' || mode === 'unknown') {
            throw new AgentCallError(mode, 'Provider failure');
          }
        },
      } };
    } },
    ledger: transcript.ledger,
  } as ConstructorParameters<typeof AgentRuntimeRouter>[0]);
  const input = control();
  if (mode === 'wrong-occurrence') input.permissionOccurrenceId = 'other';
  const value = await result(() => router.resolvePermission(CHAT, mode === 'empty-occurrence' ? '' : OCCURRENCE, decision, input, 1000));
  return { value, effects };
}

export async function routerSteerTrace(mode: string) {
  const effects: unknown[] = [];
  const transcript = createRuntimeTranscriptFixture({
    composition(chat, message) { effects.push(['take', chat, message]); },
  });
  const router = new AgentRuntimeRouter({
    registry: { getChat: () => mode === 'missing-chat' ? null : {
      ...entry, agentSessionId: mode === 'no-session' ? null : entry.agentSessionId,
    } },
    directory: { require(agentId, executorId) {
      effects.push(['require', agentId, executorId]);
      return { steering: mode === 'unsupported' ? null : {
        async steer(request, options) {
          effects.push(['steer', request.chatId, request.projectPath, request.agentSessionId, request.input, request.clientMessageId, options.dispatchDeadline]);
          if (mode === 'lost') throw new ExecutorSessionLostError('unknown', 'Connection lost');
          return { kind: 'accepted' };
        },
      } };
    } },
    ledger: transcript.ledger,
  } as ConstructorParameters<typeof AgentRuntimeRouter>[0]);
  const value = await result(() => router.steerInput(CHAT, 'content', {
    clientRequestId: 'request', clientMessageId: 'message', transcriptViewId: 'view',
  }, null, async () => {
    effects.push(['prepare']);
    if (mode === 'blocked') throw new Error('Target changed');
  }, 1234));
  return { value, effects };
}

export function routerRunningTrace(active: boolean) {
  const transcript = createRuntimeTranscriptFixture();
  if (active) {
    transcript.ledger.openProducer(CHAT);
    transcript.ledger.beginRun(CHAT, 'run-1');
  }
  const router = new AgentRuntimeRouter({
    registry: { getChat: () => entry },
    directory: { list: () => [{ descriptor: { id: 'test' } }, { descriptor: { id: 'other' } }] },
    ledger: transcript.ledger,
  } as ConstructorParameters<typeof AgentRuntimeRouter>[0]);
  return {
    chat: router.isChatRunning(CHAT),
    agent: router.isAgentSessionRunning('test', 'session-1', REMOTE),
    local: router.isAgentSessionRunning('test', 'session-1'),
    missing: router.isAgentSessionRunning('test', '', REMOTE),
    sessions: router.getRunningSessions(),
    chats: router.getRunningChatIdsSnapshot(),
    count: router.getRunningSessionCount(),
  };
}
