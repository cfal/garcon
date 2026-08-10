import { describe, expect, it } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { attachNativeMessageSource } from '../../agents/shared/native-message-source.js';
import {
  preserveRetainedUserIdentities,
  reconcileLiveMessageAppends,
  retainedMessageMatchesNative,
} from '../chat-message-reconciliation.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content, metadata = {}) {
  return new UserMessage(TS, content, undefined, metadata);
}

function retained(messages) {
  return messages.map((message, index) => ({ seq: index + 1, message }));
}

describe('chat message reconciliation', () => {
  for (const conflictPolicy of ['reject', 'native-wins']) {
    it(`keeps two ambiguous live users away from one retained user under ${conflictPolicy}`, () => {
      const upstreamRequestId = 'reused-upstream';
      const retainedMessages = retained([user('same', { upstreamRequestId })]);
      const result = reconcileLiveMessageAppends(retainedMessages, [
        user('same', { clientRequestId: 'client-1', upstreamRequestId }),
        user('same', { clientRequestId: 'client-2', upstreamRequestId }),
      ], conflictPolicy);

      expect(result.messages.map((message) => message.metadata?.clientRequestId)).toEqual([
        'client-1',
        'client-2',
      ]);
      expect(retainedMessages[0].message.metadata).toEqual({ upstreamRequestId });
    });

    it(`keeps one ambiguous live user away from two retained users under ${conflictPolicy}`, () => {
      const upstreamRequestId = 'reused-upstream';
      const retainedMessages = retained([
        user('same', { upstreamRequestId }),
        user('same', { upstreamRequestId }),
      ]);
      const result = reconcileLiveMessageAppends(retainedMessages, [
        user('same', { clientRequestId: 'client-1', upstreamRequestId }),
      ], conflictPolicy);

      expect(result.messages.map((message) => message.metadata?.clientRequestId)).toEqual([
        'client-1',
      ]);
      expect(retainedMessages.map((entry) => entry.message.metadata)).toEqual([
        { upstreamRequestId },
        { upstreamRequestId },
      ]);
    });
  }

  it('pairs equal-cardinality upstream deliveries by stable order', () => {
    const upstreamRequestId = 'reused-upstream';
    const retainedMessages = retained([
      user('same', { upstreamRequestId }),
      user('same', { upstreamRequestId }),
    ]);

    const result = reconcileLiveMessageAppends(retainedMessages, [
      user('same', { clientRequestId: 'client-1', upstreamRequestId }),
      user('same', { clientRequestId: 'client-2', upstreamRequestId }),
    ], 'reject');

    expect(result.messages).toEqual([]);
    expect(retainedMessages.map((entry) => entry.message.metadata?.clientRequestId)).toEqual([
      'client-1',
      'client-2',
    ]);
  });

  it('does not bridge equal wire payloads across distinct native sources', () => {
    const first = attachNativeMessageSource(new AssistantMessage(TS, 'same'), {
      entryId: 'turn:turn-1:item:item-1',
      withinSourceOrdinal: 0,
    });
    const second = attachNativeMessageSource(new AssistantMessage(TS, 'same'), {
      entryId: 'turn:turn-1:item:item-2',
      withinSourceOrdinal: 0,
    });

    expect(retainedMessageMatchesNative(first, second)).toBe(false);
  });

  it('preserves identities only for the matching source across a sliding native window', () => {
    const upstreamRequestId = 'reused-upstream';
    const sourcedUser = (entryId, clientRequestId) => attachNativeMessageSource(
      user('same', {
        ...(clientRequestId ? { clientRequestId } : {}),
        upstreamRequestId,
      }),
      { entryId, withinSourceOrdinal: 0 },
    );
    const retainedMessages = retained([
      sourcedUser('turn:turn-1:item:user-1', 'client-1'),
      sourcedUser('turn:turn-1:item:user-2', 'client-2'),
    ]);

    const reconciled = preserveRetainedUserIdentities(retainedMessages, [
      sourcedUser('turn:turn-1:item:user-2'),
      sourcedUser('turn:turn-1:item:user-3'),
    ]);

    expect(reconciled.map((message) => message.metadata?.clientRequestId)).toEqual([
      'client-2',
      undefined,
    ]);
  });
});
