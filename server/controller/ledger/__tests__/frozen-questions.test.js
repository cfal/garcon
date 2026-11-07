import { expect, it } from 'bun:test';
import { AssistantMessage } from '../../../../common/chat-types.js';
import { frozenConversationDrafts } from '../projection.js';

it('copies conversational questions as read-only text without mutating the source', () => {
  const questions = { id: 'set', questions: [{ id: 'question', prompt: 'Which environment?', options: [], allowFreeText: true }] };
  const message = new AssistantMessage('2026-01-01T00:00:00Z', 'Which environment?', questions);
  const drafts = frozenConversationDrafts([{ kind: 'provider-row', ordinal: 3, at: message.timestamp, providerMeta: null, message }]);
  expect(drafts[0].message).toEqual(new AssistantMessage(message.timestamp, message.content));
  expect(message.questions).toBe(questions);
});
