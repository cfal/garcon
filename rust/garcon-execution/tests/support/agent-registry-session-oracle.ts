import { ExecutionAborts } from '../../../../server/controller/agents/execution-aborts.ts';
import {
  assertExecutionAdmissionOpen,
  requireChatExecutionConfig,
} from '../../../../server/controller/agents/session-types.ts';

export function sessionConfigTrace(chat: string, input: Parameters<typeof requireChatExecutionConfig>[1]) {
  try { return { config: requireChatExecutionConfig(chat, input) }; }
  catch (error) { return { error: (error as Error).message }; }
}

export function sessionAdmissionTrace(state: 'absent' | 'open' | 'stopped') {
  const controller = new AbortController();
  if (state === 'stopped') controller.abort(new Error('Stopped before launch'));
  try {
    assertExecutionAdmissionOpen(state === 'absent' ? {} : {
      executionAdmission: { signal: controller.signal, markStarted: async () => {} },
    });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export async function executionAbortsTrace(mode: string) {
  const effects: string[][] = [];
  const ready = new Set<string>();
  let rejectNext = mode === 'async-rejection';
  const aborts = new ExecutionAborts({
    isReady(executor) { effects.push(['ready', executor]); return ready.has(executor); },
    require(agent, executor) {
      effects.push(['lookup', agent, executor]);
      if (!ready.has(executor) && !rejectNext) throw new Error('offline');
      return {
        execution: {
          async abort(handle) {
            effects.push(['abort', handle.executorId, handle.instanceId, handle.id]);
            if (rejectNext) {
              rejectNext = false;
              throw new Error('lost during abort');
            }
            return true;
          },
        },
      };
    },
  } as ConstructorParameters<typeof ExecutionAborts>[0]);
  const request = (chat: string, executorId: string, id: string) => {
    aborts.request(chat, 'agent', { executorId, id, instanceId: 'old-worker', integrationId: 'agent', kind: 'execution' }, 'cleanup');
  };
  if (mode === 'async-rejection') {
    request('chat', 'a', 'one');
    await Promise.resolve();
    ready.add('a');
    aborts.sessionResumed('a');
  } else if (mode === 'other-owner' || mode === 'replace') {
    request('chat', 'a', 'one');
    request(mode === 'replace' ? 'chat' : 'other-chat', 'b', 'two');
    ready.add('a');
    ready.add('b');
    aborts.sessionResumed('unrelated');
    aborts.sessionResumed('b');
    aborts.sessionResumed('a');
  } else {
    ready.add('a');
    request('chat', 'a', 'one');
    aborts.sessionResumed('a');
  }
  await Promise.resolve();
  return effects;
}
