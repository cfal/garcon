import { AcpRpcError } from '../../../../server-agents/common/src/acp/errors.ts';
import { AcpTurnPrompts } from '../../../../server-agents/common/src/acp/turn-prompts.ts';
import type { AcpSessionPromptResult } from '../../../../server-agents/common/src/acp/protocol.ts';
import type { AcpReply } from '../../../../server-agents/common/src/acp/transport.ts';

type Step =
  | ['run']
  | ['hold']
  | ['release']
  | ['steer', number]
  | ['sent', number]
  | ['reply', number, string]
  | ['rpc-error', number, number, string]
  | ['reject', number, string]
  | ['failure', string]
  | ['tick', number]
  | ['snapshot'];

export async function scriptedAcpTurnPrompts(steps: Step[]): Promise<unknown[]> {
  const events: unknown[] = [];
  const senders: Array<{
    onSent?: () => void;
    onReply: (reply: AcpReply<AcpSessionPromptResult>) => void;
    pending: PromiseWithResolvers<AcpSessionPromptResult>;
  }> = [];
  let failure: string | null = null;
  const turn = new AcpTurnPrompts({
    steering: {
      likelySuperseded: result => result.stopReason === 'cancelled',
      refused: error => error.code === -32001,
    },
    takeFailure: () => {
      const taken = failure;
      failure = null;
      return taken;
    },
    onBoundary: detail => events.push({ event: 'boundary', failure: detail }),
    onSteerable: () => events.push({ event: 'steerable' }),
  });

  const capture = (onReply: (reply: AcpReply<AcpSessionPromptResult>) => void, onSent?: () => void) => {
    const pending = Promise.withResolvers<AcpSessionPromptResult>();
    senders.push({ onSent, onReply, pending });
    return pending.promise;
  };
  let release: (() => void) | undefined;
  let clock = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { due: number; fire: () => void }>();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fire: () => void, ms: number) => {
    const token = { unref() {} } as ReturnType<typeof setTimeout>;
    timers.set(token, { due: clock + ms, fire });
    return token;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((token: ReturnType<typeof setTimeout>) => {
    timers.delete(token);
  }) as typeof clearTimeout;

  try {
    for (const step of steps) {
      switch (step[0]) {
        case 'run':
          void turn.run(capture).then(
            () => events.push({ event: 'drained' }),
            (error: Error) => events.push({ event: 'drained', error: error.message }),
          );
          break;
        case 'hold': {
          const gate = Promise.withResolvers<void>();
          release = gate.resolve;
          void turn.withSteerSlot(async () => {
            await gate.promise;
            return { kind: 'accepted' };
          });
          break;
        }
        case 'release':
          release!();
          break;
        case 'steer': {
          const decision = turn.steer((onSent, onReply) => capture(onReply, onSent), step[1]);
          void decision.then(result => events.push({ event: 'decision', result }));
          break;
        }
        case 'sent':
          senders[step[1]]!.onSent!();
          break;
        case 'reply': {
          const sender = senders[step[1]]!;
          const result = { stopReason: step[2] };
          sender.onReply({ result });
          sender.pending.resolve(result);
          break;
        }
        case 'rpc-error': {
          const sender = senders[step[1]]!;
          const error = new AcpRpcError(step[3], step[2]);
          sender.onReply({ error });
          sender.pending.reject(error);
          break;
        }
        case 'reject':
          senders[step[1]]!.pending.reject(new Error(step[2]));
          break;
        case 'failure':
          failure = step[1];
          break;
        case 'tick':
          clock += step[1];
          for (const [token, timer] of timers) {
            if (timer.due > clock) continue;
            timers.delete(token);
            timer.fire();
          }
          break;
        case 'snapshot':
          events.push({ event: 'snapshot', closed: turn.closed, awaitingLateReply: turn.awaitingLateReply });
          break;
      }
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    return events;
  } finally {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
  }
}
