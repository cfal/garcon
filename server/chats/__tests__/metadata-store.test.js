import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MetadataIndex } from '../metadata-store.js';

const mockRegistry = {
  listAllChats: () => ({}),
  onChatRemoved: mock(() => {}),
};
const mockProviders = {
  getPreview: mock(() => Promise.resolve(null)),
};

let chatCounter = 0;

describe('metadata-store', () => {
  let metadata;
  let chatId;

  beforeEach(() => {
    chatCounter += 1;
    chatId = `meta-test-${chatCounter}`;
    metadata = new MetadataIndex(mockRegistry, mockProviders);
    metadata.addNewChatMetadata(chatId, 'initial message');
  });

  describe('extractPreviewText uses full message content', () => {
    it('keeps full multiline content from assistant-message', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'first line\nsecond line\nthird' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('first line\nsecond line\nthird');
    });

    it('keeps full multiline content from user-message', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'user-message', timestamp: '2026-01-02T00:00:00Z', content: 'question line\nmore details' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('question line\nmore details');
    });

    it('returns full content when no newline', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'single line' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('single line');
    });

    it('preserves whitespace', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: '  padded content  \nmore' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('  padded content  \nmore');
    });

    it('returns empty string for non-displayable message types', () => {
      const metaBefore = metadata.getChatMetadata(chatId);
      const prevMessage = metaBefore.lastMessage;

      metadata.updateFromAppendedMessages(chatId, [
        { type: 'tool-use', timestamp: '2026-01-02T00:00:00Z', toolId: 't1', toolName: 'Read', toolInput: '{}' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe(prevMessage);
    });
  });

  describe('updateFromAppendedMessages', () => {
    it('updates lastActivity from message timestamps', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'tool-use', timestamp: '2099-01-01T00:00:00Z', toolId: 't1', toolName: 'X', toolInput: '{}' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastActivity).toBe('2099-01-01T00:00:00Z');
    });

    it('warns and returns early when chat is not in metadata store', () => {
      // Should not throw; logs a warning and returns.
      metadata.updateFromAppendedMessages('unknown-chat', [
        { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'hello' },
      ]);
      expect(metadata.getChatMetadata('unknown-chat')).toBeNull();
    });
  });
});
