import { describe, expect, test } from 'bun:test';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import { AgentProjectionProducerEventChannel } from '../projection-events.js';

describe('AgentProjectionProducerEventChannel', () => {
  test('forwards producer events until unsubscribe', () => {
    const channel = new AgentProjectionProducerEventChannel();
    const events: unknown[] = [];
    const unsubscribe = channel.subscribe((event) => events.push(event));
    const owner = {
      agentOwnershipEpoch: agentOwnershipEpoch('ownership-1'),
      commandType: 'agent-run' as const,
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    };
    const event = {
      type: 'processing' as const,
      chatId: 'chat',
      processing: true,
      operation: {
        ...owner,
        clientMessageId: 'message-1',
        turnOwner: owner,
      },
    };
    channel.emit(event);
    unsubscribe();
    channel.emit({ ...event, processing: false });
    expect(events).toEqual([event]);
  });
});
