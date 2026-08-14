import { describe, expect, it } from 'bun:test';

import { UserMessage } from '../../../common/chat-types.js';
import { attachNativeMessageSource } from '../../agents/shared/native-message-source.js';
import { NativeUserIdentityRegistry } from '../native-user-identity-registry.js';

describe('NativeUserIdentityRegistry', () => {
  it('preserves exact user identities across rewritten native fork positions', () => {
    const sourceMessages = [
      nativeUserMessage(4, 'previous'),
      nativeUserMessage(8, 'repeat'),
    ];
    const targetMessages = [
      nativeUserMessage(2, 'previous'),
      nativeUserMessage(3, 'repeat'),
    ];
    const identities = new NativeUserIdentityRegistry();
    identities.bind('source-chat', sourceMessages[1], {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    });
    identities.applyFromNativeStart('source-chat', sourceMessages);

    identities.copyChat('source-chat', 'target-chat');

    const identified = identities.applyFromNativeStart('target-chat', targetMessages);
    expect(identified[0].metadata).toBeUndefined();
    expect(identified[1].metadata).toEqual({
      clientRequestId: 'request-1',
      upstreamRequestId: 'message-1',
      turnId: 'turn-1',
      deliveryStatus: 'accepted',
    });
    expect(identities.apply('target-chat', [targetMessages[1]])[0].metadata)
      .toEqual(identified[1].metadata);
  });

  it('records absolute native user positions from complete structural evidence', () => {
    const sourceMessages = [
      nativeUserMessage(4, 'repeat'),
      nativeUserMessage(8, 'repeat'),
    ];
    const identities = new NativeUserIdentityRegistry();
    expect(identities.bindPosition({
      chatId: 'source-chat',
      messages: sourceMessages,
      position: { previousNativeUserSourceKey: null, userOffset: 2 },
      includesNativeStart: true,
      identity: { clientRequestId: 'request-2' },
    })).toBe(true);

    identities.copyChat('source-chat', 'target-chat');

    const identified = identities.applyFromNativeStart('target-chat', [
      nativeUserMessage(2, 'repeat'),
      nativeUserMessage(3, 'repeat'),
    ]);
    expect(identified.map((message) => message.metadata?.clientRequestId)).toEqual([
      undefined,
      'request-2',
    ]);
  });
});

function nativeUserMessage(lineNumber, content) {
  return attachNativeMessageSource(
    new UserMessage('2026-08-14T00:00:00.000Z', content),
    { lineNumber, withinSourceOrdinal: 0 },
  );
}
