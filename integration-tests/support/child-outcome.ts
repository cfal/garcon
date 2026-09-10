import { expect } from 'bun:test';
import type { AgentChildOutcomeNoticeDetail } from '../../common/garcon-agent-result.js';
import { parseGarconCommandResult } from '../../common/garcon-command-results.js';
import type { ChatMessagesMessage, ServerWsMessage } from '../../common/ws-events.js';
import type { HeldResponsesRequest } from './fake-openai-responses-server.js';
import type { GarconTestClient } from './garcon-client.js';

interface ChildOutcomeTarget {
  readonly chatId: string;
  readonly type: AgentChildOutcomeNoticeDetail['type'];
  readonly ref: string;
  readonly status: AgentChildOutcomeNoticeDetail['status'];
  readonly afterIndex: number;
}

function matchingOutcome(event: ServerWsMessage, target: ChildOutcomeTarget): AgentChildOutcomeNoticeDetail | null {
  if (event.type !== 'chat-messages' || event.chatId !== target.chatId) return null;
  for (const { message } of event.messages) {
    const detail = message.type === 'transcript-notice' ? message.detail : undefined;
    if ((detail?.type === 'agent-start-outcome' || detail?.type === 'agent-resume-outcome')
      && detail.type === target.type && detail.ref === target.ref && detail.status === target.status) return detail;
  }
  return null;
}

export async function waitForChildOutcome(
  client: Pick<GarconTestClient, 'waitForEvent'>,
  target: ChildOutcomeTarget,
): Promise<AgentChildOutcomeNoticeDetail> {
  const event = await client.waitForEvent(
    (event): event is ChatMessagesMessage => matchingOutcome(event, target) !== null,
    `${target.type} ${target.ref} ${target.status} on ${target.chatId}`,
    { afterIndex: target.afterIndex, timeoutMs: 60_000 },
  );
  const outcome = matchingOutcome(event, target);
  if (!outcome) throw new Error('Missing matching child outcome');
  return outcome;
}

export async function waitForChildReply(
  client: Pick<GarconTestClient, 'waitForEvent'>,
  held: Pick<HeldResponsesRequest, 'received'>,
  target: ChildOutcomeTarget,
): Promise<AgentChildOutcomeNoticeDetail> {
  // Child startup and execution do not consume the held request's parent-delivery deadline.
  const outcome = await waitForChildOutcome(client, target);
  const request = await held.received;
  expect(parseGarconCommandResult(request.lastUserText)).toEqual(outcome);
  return outcome;
}
