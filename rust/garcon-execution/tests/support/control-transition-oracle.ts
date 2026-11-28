import * as transitions from '../../../../server/controller/chat-execution/chat-execution-control-transitions.ts';

type ControlTransitionName = keyof typeof transitions;
type Transition = (...args: unknown[]) => unknown;

export function replayControlTransition(
  name: ControlTransitionName,
  args: unknown[],
  now: string,
  ids: string[],
  receiptKeys: string[][],
) {
  let idCalls = 0;
  let receiptLookups = 0;
  const transition = (transitions[name] as unknown as Transition)(...args, {
    now,
    newId: () => ids[idCalls++] ?? 'unexpected-id',
    unsettledQueueReceiptKeys: () => new Set(receiptKeys[receiptLookups++] ?? []),
  });
  return { transition, idCalls, receiptLookups };
}
