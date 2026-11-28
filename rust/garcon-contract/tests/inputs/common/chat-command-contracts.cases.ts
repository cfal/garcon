import { expect, test } from 'bun:test';
import {
  CHAT_START_ORIGINS,
  parseAgentInterruptAndSendCommandRequest,
  parseAgentStopCommandRequest,
  parseCompactCommandRequest,
  parseDeleteChatCommandRequest,
  parseQueueEntryDeleteCommandRequest,
  parseQueueMutationRequest,
  parseQueueResumeRequest,
  recordsStartupPreferences,
} from '../../../../../common/chat-command-contracts.ts';

const chatId = '1783725900000000';
const command = { chatId, clientRequestId: ' fixture-request ' };

test('records startup preference policy for each origin', () => {
  for (const origin of CHAT_START_ORIGINS) expect(recordsStartupPreferences(origin)).toBe(origin === 'interactive');
});

test('records stop, interrupt, compaction, and chat deletion', () => {
  expect(parseAgentStopCommandRequest({ ...command, agentId: ' codex ' })).toEqual({ chatId, clientRequestId: 'fixture-request', agentId: 'codex' });
  expect(() => parseAgentStopCommandRequest({ agentId: 5 })).toThrow('agentId must be a string');
  expect(parseAgentInterruptAndSendCommandRequest({ ...command, agentId: null })).toEqual({ chatId, clientRequestId: 'fixture-request' });
  expect(() => parseAgentInterruptAndSendCommandRequest({ ...command, chatId: 'bad' })).toThrow('chatId must be a valid 16-digit Unix-microsecond timestamp');
  expect(parseCompactCommandRequest({ ...command, instructions: ' Keep this. ' }).instructions).toBe(' Keep this. ');
  expect(() => parseCompactCommandRequest({ instructions: false })).toThrow('instructions must be a string');
  expect(parseDeleteChatCommandRequest({ chatId })).toEqual({ chatId });
  expect(() => parseDeleteChatCommandRequest({ chatId: 'bad' })).toThrow('chatId must be a valid 16-digit Unix-microsecond timestamp');
});

test('records queue delete, pause, and resume ordering', () => {
  expect(parseQueueEntryDeleteCommandRequest({ ...command, entryId: ' entry ' }).entryId).toBe('entry');
  expect(() => parseQueueEntryDeleteCommandRequest({ ...command, entryId: 'x'.repeat(129) })).toThrow('entryId must be at most 128 bytes');
  expect(parseQueueMutationRequest({ chatId, ignored: true })).toEqual({ chatId });
  expect(() => parseQueueMutationRequest(null)).toThrow('request body must be an object');
  expect(parseQueueResumeRequest({ chatId, pauseId: ' paused ' })).toEqual({ chatId, pauseId: 'paused' });
  expect(() => parseQueueResumeRequest({ chatId, pauseId: null })).toThrow('pauseId is required');
});
