import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { AttentionTracker } from '../../notifications/attention-tracker.js';
import { PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage, UserMessage, AssistantMessage } from '../../../common/chat-types.js';

function createMockProviderRegistry() {
  const emitter = new EventEmitter();
  return {
    onMessages: (cb) => emitter.on('messages', cb),
    onFinished: (cb) => emitter.on('finished', cb),
    onFailed: (cb) => emitter.on('failed', cb),
    emitMessages: (chatId, msgs) => emitter.emit('messages', chatId, msgs),
    emitFinished: (chatId, exitCode) => emitter.emit('finished', chatId, exitCode),
    emitFailed: (chatId, msg) => emitter.emit('failed', chatId, msg),
  };
}

function createMockQueue() {
  const emitter = new EventEmitter();
  return {
    onChatIdle: (cb) => emitter.on('chat-idle', cb),
    onSessionStopped: (cb) => emitter.on('session-stopped', cb),
    emitChatIdle: (chatId) => emitter.emit('chat-idle', chatId),
    emitSessionStopped: (chatId, success) => emitter.emit('session-stopped', chatId, success),
  };
}

function createMockSettings(telegramConfig = { enabled: true, chatId: '99999' }) {
  return {
    getUiSettings: mock(() => Promise.resolve({
      notifications: { telegram: telegramConfig },
    })),
    getChatName: mock(() => null),
  };
}

function createMockRegistry(entry = { provider: 'claude', projectPath: '/home/user/repo' }) {
  return {
    getChat: mock(() => entry),
  };
}

// Messages stored in the mock history cache. Tests push into this array
// before triggering events.
let historyMessages;
function createMockHistory() {
  return {
    getMessages: mock(() => historyMessages),
  };
}

function createMockTelegram() {
  return {
    isConfigured: true,
    send: mock(() => Promise.resolve(true)),
  };
}

describe('AttentionTracker', () => {
  let providers, queue, settings, registry, history, telegram;

  beforeEach(() => {
    providers = createMockProviderRegistry();
    queue = createMockQueue();
    settings = createMockSettings();
    registry = createMockRegistry();
    historyMessages = [];
    history = createMockHistory();
    telegram = createMockTelegram();
  });

  function createTracker() {
    return new AttentionTracker(providers, queue, settings, registry, history, telegram);
  }

  // Simulates a conversation round: adds messages to history and emits
  // the assistant message through onMessages (as the real provider does).
  function simulateConversation(chatId, userText, assistantText) {
    historyMessages.push({ type: 'user-message', content: userText });
    historyMessages.push({ type: 'assistant-message', content: assistantText });
    providers.emitMessages(chatId, [new AssistantMessage('2024-01-01T00:00:01Z', assistantText)]);
  }

  describe('permission notifications', () => {
    it('sends HTML notification with user message and permission info', async () => {
      createTracker();
      historyMessages.push({ type: 'user-message', content: 'deploy the app' });
      const msg = new PermissionRequestMessage('2024-01-01T00:00:01Z', 'perm-1', 'Bash');
      providers.emitMessages('c1', [msg]);

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
      const [chatId, html, parseMode] = telegram.send.mock.calls[0];
      expect(chatId).toBe('99999');
      expect(parseMode).toBe('HTML');
      // No generated title, so user message becomes the bold header
      expect(html).toContain('<b>deploy the app</b>');
      expect(html).toContain('Needs permission: Bash');
      expect(html).toContain('claude');
    });

    it('deduplicates permission notifications by ID', async () => {
      createTracker();
      const msg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', 'Bash');
      providers.emitMessages('c1', [msg]);
      providers.emitMessages('c1', [msg]);

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('clears pending permission on resolved', async () => {
      createTracker();
      const reqMsg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', 'Bash');
      const resMsg = new PermissionResolvedMessage('2024-01-01T00:00:01Z', 'perm-1', true);

      providers.emitMessages('c1', [reqMsg]);
      providers.emitMessages('c1', [resMsg]);

      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });

    it('clears pending permission on cancelled', async () => {
      createTracker();
      const reqMsg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', 'Bash');
      const cancelMsg = new PermissionCancelledMessage('2024-01-01T00:00:01Z', 'perm-1', 'cancelled');

      providers.emitMessages('c1', [reqMsg]);
      providers.emitMessages('c1', [cancelMsg]);

      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('chat-idle notifications', () => {
    it('sends notification with user message as title and response', async () => {
      createTracker();
      simulateConversation('c1', 'fix the bug', 'Fixed the null pointer in main.ts');
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
      const [, html, parseMode] = telegram.send.mock.calls[0];
      expect(parseMode).toBe('HTML');
      // No generated title, so user message is the bold header
      expect(html).toContain('<b>fix the bug</b>');
      expect(html).toContain('Fixed the null pointer');
      expect(html).toContain('<code>claude');
    });

    it('shows generated title with quoted user message when title exists', async () => {
      settings.getChatName = mock(() => 'Bug Fix Session');
      createTracker();
      simulateConversation('c1', 'fix the bug', 'Fixed the null pointer in main.ts');
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('<b>Bug Fix Session</b>');
      expect(html).toContain('<blockquote>fix the bug</blockquote>');
      expect(html).toContain('Fixed the null pointer');
    });

    it('falls back to truncated chat ID when no history', async () => {
      createTracker();
      historyMessages = null;
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('<b>c1</b>');
    });

    it('sends failed notification with detail instead of response', async () => {
      createTracker();
      simulateConversation('c1', 'deploy it', 'Starting deploy...');
      providers.emitFailed('c1', 'CLI crashed');
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('<b>deploy it</b>');
      expect(html).toContain('Failed: CLI crashed');
      expect(html).not.toContain('Starting deploy');
    });

    it('sends failed notification when turn finishes with non-zero exit code', async () => {
      createTracker();
      providers.emitFinished('c1', 1);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('Failed');
    });

    it('does NOT send idle notification when permission is pending', async () => {
      createTracker();
      const msg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', 'Bash');
      providers.emitMessages('c1', [msg]);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('shortens home directory path in footer', async () => {
      createTracker();
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('~/repo');
      expect(html).not.toContain('/home/user/repo');
    });
  });

  describe('session-stopped notifications', () => {
    it('sends stopped notification with user message as title', async () => {
      createTracker();
      historyMessages.push({ type: 'user-message', content: 'run tests' });
      queue.emitSessionStopped('c1', true);

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
      const [, html, parseMode] = telegram.send.mock.calls[0];
      expect(parseMode).toBe('HTML');
      expect(html).toContain('<b>run tests</b>');
      expect(html).toContain('Stopped');
    });
  });

  describe('settings gating', () => {
    it('sends nothing when telegram is disabled', async () => {
      settings = createMockSettings({ enabled: false, chatId: '99999' });
      createTracker();
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('sends nothing when chatId is empty', async () => {
      settings = createMockSettings({ enabled: true, chatId: '' });
      createTracker();
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('sends nothing when telegram notifier is not configured', async () => {
      telegram = { isConfigured: false, send: mock(() => Promise.resolve(true)) };
      createTracker();
      providers.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });
  });
});
