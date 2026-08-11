import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { AttentionTracker } from '../../notifications/attention-tracker.js';
import { PermissionRequestMessage, AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';

function commitApplied(chatId, messages) {
  return {
    event: {
      kind: 'commit',
      chatId,
      agentOwnershipEpoch: 'ownership-1',
      promoted: [],
      appended: messages.map((message, index) => ({
        id: `entry-${index}`,
        lifetime: 'durable',
        source: null,
        provenance: null,
        message,
      })),
    },
  };
}

function controlApplied(chatId, mutation) {
  return {
    event: {
      kind: 'control',
      chatId,
      agentOwnershipEpoch: 'ownership-1',
      mutation,
    },
  };
}

function createMockAgentRegistry() {
  const emitter = new EventEmitter();
  return {
    onProjectionApplied: (cb) => emitter.on('projection', cb),
    onProcessing: (cb) => emitter.on('processing', cb),
    onFinished: (cb) => emitter.on('finished', cb),
    onFailed: (cb) => emitter.on('failed', cb),
    emitAssistant: (chatId, msgs) => emitter.emit('projection', commitApplied(chatId, msgs)),
    emitPermissionRequest: (chatId, message) => emitter.emit('projection', controlApplied(chatId, {
      kind: 'upsert',
      row: {
        id: message.permissionRequestId,
        incarnation: 'incarnation-1',
        anchorEntryId: null,
        displayOrder: 0,
        message,
      },
    })),
    emitPermissionRemoved: (chatId, permissionRequestId) => emitter.emit('projection', controlApplied(chatId, {
      kind: 'remove',
      id: permissionRequestId,
      incarnation: 'incarnation-1',
    })),
    emitPermissionCleared: (chatId) => emitter.emit('projection', controlApplied(chatId, {
      kind: 'clear',
    })),
    emitProcessing: (chatId, processing) => emitter.emit('processing', chatId, processing),
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

function createMockSettings(telegramConfig = { enabled: true }) {
  return {
    getUiSettings: mock(() => Promise.resolve({
      notifications: { telegram: telegramConfig },
    })),
    getChatName: mock(() => null),
  };
}

function createMockRegistry(entry = { agentId: 'claude', projectPath: '/home/user/repo' }) {
  const emitter = new EventEmitter();
  return {
    getChat: mock(() => entry),
    onChatRemoved: (cb) => emitter.on('chat-removed', cb),
    emitChatRemoved: (chatId) => emitter.emit('chat-removed', chatId),
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

function createMockTelegramSettings(chatId = '99999') {
  return {
    getRecipientChatId: mock(() => chatId),
  };
}

describe('AttentionTracker', () => {
  let agents, queue, settings, registry, history, telegram, telegramSettings;

  beforeEach(() => {
    agents = createMockAgentRegistry();
    queue = createMockQueue();
    settings = createMockSettings();
    registry = createMockRegistry();
    historyMessages = [];
    history = createMockHistory();
    telegram = createMockTelegram();
    telegramSettings = createMockTelegramSettings();
  });

  function createTracker() {
    return new AttentionTracker(agents, queue, settings, registry, history, telegram, telegramSettings);
  }

  // Simulates a conversation round: adds messages to history and applies
  // the assistant row through a projection commit (as the real ingress does).
  function simulateConversation(chatId, userText, assistantText) {
    historyMessages.push({ type: 'user-message', content: userText });
    historyMessages.push({ type: 'assistant-message', content: assistantText });
    agents.emitAssistant(chatId, [new AssistantMessage('2024-01-01T00:00:01Z', assistantText)]);
  }

  describe('permission notifications', () => {
    it('sends HTML notification with user message and permission info', async () => {
      createTracker();
      historyMessages.push({ type: 'user-message', content: 'deploy the app' });
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:01Z', 'tool-1', 'echo hello');
      const msg = new PermissionRequestMessage('2024-01-01T00:00:01Z', 'perm-1', bashTool);
      agents.emitPermissionRequest('c1', msg);

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

    it('uses agentId from the chat registry in notification metadata', async () => {
      registry = createMockRegistry({ agentId: 'codex', projectPath: '/home/user/repo' });
      createTracker();
      historyMessages.push({ type: 'user-message', content: 'deploy the app' });
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:01Z', 'tool-1', 'echo hello');
      const msg = new PermissionRequestMessage('2024-01-01T00:00:01Z', 'perm-1', bashTool);
      agents.emitPermissionRequest('c1', msg);

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('codex');
    });

    it('deduplicates permission notifications by ID', async () => {
      createTracker();
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:00Z', 'tool-1', 'echo hello');
      const msg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', bashTool);
      agents.emitPermissionRequest('c1', msg);
      agents.emitPermissionRequest('c1', msg);

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('clears pending permission on control removal', async () => {
      createTracker();
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:00Z', 'tool-1', 'echo hello');
      const reqMsg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', bashTool);

      agents.emitPermissionRequest('c1', reqMsg);
      agents.emitPermissionRemoved('c1', 'perm-1');

      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });

    it('clears pending permissions on a control clear', async () => {
      createTracker();
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:00Z', 'tool-1', 'echo hello');
      const reqMsg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', bashTool);

      agents.emitPermissionRequest('c1', reqMsg);
      agents.emitPermissionCleared('c1');

      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('chat-idle notifications', () => {
    it('sends notification with user message as title and response', async () => {
      createTracker();
      simulateConversation('c1', 'fix the bug', 'Fixed the null pointer in main.ts');
      agents.emitFinished('c1', 0);
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
      agents.emitFinished('c1', 0);
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
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('<b>c1</b>');
    });

    it('sends failed notification with detail instead of response', async () => {
      createTracker();
      simulateConversation('c1', 'deploy it', 'Starting deploy...');
      agents.emitFailed('c1', 'CLI crashed');
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('<b>deploy it</b>');
      expect(html).toContain('Failed: CLI crashed');
      expect(html).not.toContain('Starting deploy');
    });

    it('sends failed notification when turn finishes with non-zero exit code', async () => {
      createTracker();
      agents.emitFinished('c1', 1);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      const [, html] = telegram.send.mock.calls[0];
      expect(html).toContain('Failed');
    });

    it('sends one notification for repeated idle events from one settle', async () => {
      createTracker();
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('re-arms idle notification delivery when new messages arrive', async () => {
      createTracker();
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');
      simulateConversation('c1', 'continue', 'Continued');
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });

    it('does NOT send idle notification when permission is pending', async () => {
      createTracker();
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:00Z', 'tool-1', 'echo hello');
      const msg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', bashTool);
      agents.emitPermissionRequest('c1', msg);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('clears pending permission state when a chat is removed', async () => {
      createTracker();
      const bashTool = new BashToolUseMessage('2024-01-01T00:00:00Z', 'tool-1', 'echo hello');
      const msg = new PermissionRequestMessage('2024-01-01T00:00:00Z', 'perm-1', bashTool);
      agents.emitPermissionRequest('c1', msg);
      registry.emitChatRemoved('c1');
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });

    it('shortens home directory path in footer', async () => {
      createTracker();
      agents.emitFinished('c1', 0);
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
      queue.emitSessionStopped('c1', 'interrupt-requested');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).toHaveBeenCalledTimes(1);
      const [, html, parseMode] = telegram.send.mock.calls[0];
      expect(parseMode).toBe('HTML');
      expect(html).toContain('<b>run tests</b>');
      expect(html).toContain('Stopped');
    });

    it.each(['already-idle', 'failed'])('does not report %s as an acknowledged stop', async (outcome) => {
      createTracker();
      historyMessages.push({ type: 'user-message', content: 'run tests' });
      queue.emitSessionStopped('c1', outcome);

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });
  });

  describe('settings gating', () => {
    it('sends nothing when telegram is disabled', async () => {
      settings = createMockSettings({ enabled: false });
      createTracker();
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('sends nothing when recipient is not linked', async () => {
      telegramSettings = createMockTelegramSettings('');
      createTracker();
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('sends nothing when telegram notifier is not configured', async () => {
      telegram = { isConfigured: false, send: mock(() => Promise.resolve(true)) };
      createTracker();
      agents.emitFinished('c1', 0);
      queue.emitChatIdle('c1');

      await new Promise(r => setTimeout(r, 10));
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('logs the Garcon chat id when Telegram delivery fails', async () => {
      telegram = { isConfigured: true, send: mock(() => Promise.resolve(false)) };
      telegramSettings = createMockTelegramSettings('telegram-recipient-1');
      const warn = console.warn;
      console.warn = mock(() => undefined);
      try {
        createTracker();
        agents.emitFinished('garcon-chat-1', 0);
        queue.emitChatIdle('garcon-chat-1');

        await new Promise(r => setTimeout(r, 10));
        expect(console.warn).toHaveBeenCalledWith(
          '[notifications:attention-tracker]',
          'attention: telegram delivery failed for chat garcon-chat-1',
        );
      } finally {
        console.warn = warn;
      }
    });
  });
});
