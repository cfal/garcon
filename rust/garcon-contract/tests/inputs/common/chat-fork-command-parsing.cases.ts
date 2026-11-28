import { expect, test } from 'bun:test';
import {
  parseDeleteChatCommandRequest, parseForkChatCommandRequest, parseHandoffForkConsent,
} from '../../../../../common/chat-fork-command-parsing.ts';

const chatId = '1783725900000000';
const sourceChatId = '1783725900000001';

test('records explicit consent and a complete cutoff', () => {
  expect(parseHandoffForkConsent({ allowHandoffFork: true })).toBe(true);
  expect(parseHandoffForkConsent({ allowHandoffFork: false })).toBeUndefined();
  expect(parseHandoffForkConsent({})).toBeUndefined();
  expect(() => parseHandoffForkConsent({ allowHandoffFork: null })).toThrow('allowHandoffFork must be a boolean');
  const input = { chatId, sourceChatId, upToOrdinal: 4, transcriptViewId: 'view', clientRequestId: 'fork', allowHandoffFork: true };
  expect(parseForkChatCommandRequest(input)).toEqual(input);
  expect(parseForkChatCommandRequest({ chatId, sourceChatId, allowHandoffFork: false })).toEqual({ chatId, sourceChatId });
  expect(() => parseForkChatCommandRequest({ ...input, upToOrdinal: -1 })).toThrow('upToOrdinal must be a positive integer');
  expect(() => parseForkChatCommandRequest({ ...input, upToOrdinal: undefined })).toThrow('transcriptViewId requires upToOrdinal');
  expect(() => parseForkChatCommandRequest({ ...input, transcriptViewId: undefined })).toThrow('upToOrdinal requires transcriptViewId');
  expect(parseDeleteChatCommandRequest({ chatId })).toEqual({ chatId });
  expect(() => parseDeleteChatCommandRequest({ chatId: 5 })).toThrow('chatId is required');
});
