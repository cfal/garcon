import { describe, expect, it } from 'bun:test';
import { UserMessage } from '@garcon/common/chat-types';
import {
  attachNativeMessageSource,
  getNativeMessageSource,
} from '../../native-message-source.js';

describe('native message sources', () => {
  it('retains the zero byte offset of a source file first record', () => {
    const message = attachNativeMessageSource(
      new UserMessage('2026-01-01T00:00:00.000Z', 'first'),
      { lineNumber: 1, byteOffset: 0 },
    );

    expect(getNativeMessageSource(message)).toEqual({ lineNumber: 1, byteOffset: 0 });
  });
});
