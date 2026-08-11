import { describe, it, expect, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadClaudeChatMessages } from '../history-loader.js';
import { PendingUserInputService } from '../../../../../../server/chats/pending-user-input-service.js';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { transcriptRevision } from '@garcon/server-agent-common/lib/transcript-revision';
import { CLAUDE_STEERING_PROMPT_PREFIX } from '../user-input.js';

async function withTempJsonl(lines, fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-load-test-'));
  const filePath = path.join(tmpDir, 'session.jsonl');
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe('Claude pending-input evidence', () => {
  it('preserves a captured CLI entity-bearing input through native reconciliation', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/claude-user-message-entities.jsonl', import.meta.url));
    const content = 'Fixture capture only. Do not inspect or modify files. Preserve this marker as the literal user input in the session transcript: &amp; &lt; &gt; &quot; &#39; <literal>. Reply only: acknowledged';
    const service = new PendingUserInputService({
      loadNativeMessages: () => loadClaudeChatMessages(fixturePath),
      getRetainedHistoryMessages: () => [],
    });
    await service.register('chat-1', content, {
      clientRequestId: 'request-1',
      createdAt: '2026-07-17T15:20:02.700Z',
    });

    const nativeMessages = await loadClaudeChatMessages(fixturePath);
    expect(nativeMessages).toMatchObject([{ type: 'user-message', content }]);
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('reconciles a user input persisted only as a queued command attachment', async () => {
    const content = 'it finished now';
    const queuedCommand = {
      sessionId: 'session-1',
      type: 'attachment',
      uuid: 'queued-1',
      timestamp: '2026-07-21T14:00:00.000Z',
      attachment: {
        type: 'queued_command',
        prompt: content,
        commandMode: 'prompt',
        timestamp: '2026-07-21T14:00:01.000Z',
      },
    };

    await withTempJsonl([JSON.stringify(queuedCommand)], async (filePath) => {
      const service = new PendingUserInputService({
        loadNativeMessages: () => loadClaudeChatMessages(filePath),
        getRetainedHistoryMessages: () => [],
      });
      await service.register('chat-1', content, {
        clientRequestId: 'request-1',
        createdAt: '2026-07-21T14:00:00.500Z',
      });

      const messages = await loadClaudeChatMessages(filePath);
      expect(messages).toMatchObject([{
        type: 'user-message',
        content,
        timestamp: '2026-07-21T14:00:01.000Z',
      }]);
      expect(getNativeMessageSource(messages[0])).toEqual({
        entryId: 'queued-1',
        lineNumber: 1,
      });

      await service.reconcileNativeHistory('chat-1');
      expect(service.listForChat('chat-1')).toEqual([]);
    });
  });

  it('filters provider task notifications while preserving normal user messages', async () => {
    const entries = [
      {
        sessionId: 'session-1',
        type: 'queue-operation',
        uuid: 'queue-1',
        timestamp: '2026-07-21T14:00:00.000Z',
        operation: 'enqueue',
        content: 'do not duplicate this',
      },
      {
        sessionId: 'session-1',
        type: 'attachment',
        uuid: 'task-attachment',
        timestamp: '2026-07-21T14:00:01.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'task-notification',
          prompt: '<task-notification>background task finished</task-notification>',
        },
      },
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'task-user',
        timestamp: '2026-07-21T14:00:02.000Z',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'A task completed with ordinary-looking prose.' },
      },
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'fallback-task-user',
        timestamp: '2026-07-21T14:00:03.000Z',
        message: {
          role: 'user',
          content: '<task-notification>fallback notification</task-notification>',
        },
      },
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'normal-user',
        timestamp: '2026-07-21T14:00:04.000Z',
        message: { role: 'user', content: 'A task completed with ordinary-looking prose.' },
      },
    ];

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);

      expect(messages).toMatchObject([{
        type: 'user-message',
        content: 'A task completed with ordinary-looking prose.',
      }]);
      expect(getNativeMessageSource(messages[0])).toEqual({
        entryId: 'normal-user',
        lineNumber: 5,
      });
    });
  });
});

describe('Claude steering history projection', () => {
  it('preserves exact recognized steering text and bypasses provider-owned filters', async () => {
    const spaced = '  keep boundary whitespace  ';
    const filtered = 'Caveat: keep the existing fallback';
    const entries = [
      {
        sessionId: 'session',
        type: 'user',
        uuid: 'following-batch',
        timestamp: '2026-07-21T14:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}${spaced}` },
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}${filtered}` },
          ],
        },
      },
      {
        sessionId: 'session',
        type: 'attachment',
        uuid: 'inline-steer',
        timestamp: '2026-07-21T14:00:02.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: [{
            type: 'text',
            text: `${CLAUDE_STEERING_PROMPT_PREFIX}<system-reminder>literal guidance</system-reminder>`,
          }],
        },
      },
    ];

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);
      expect(messages.map((message) => message.content)).toEqual([
        spaced,
        filtered,
        '<system-reminder>literal guidance</system-reminder>',
      ]);

      const service = new PendingUserInputService({
        loadNativeMessages: () => loadClaudeChatMessages(filePath),
        getRetainedHistoryMessages: () => [],
      });
      await service.register('chat-1', spaced, {
        clientRequestId: 'request-spaced',
        createdAt: '2026-07-21T14:00:00.500Z',
        deliveryStatus: 'accepted',
      });
      await service.register('chat-1', filtered, {
        clientRequestId: 'request-filtered',
        createdAt: '2026-07-21T14:00:00.500Z',
        deliveryStatus: 'accepted',
      });
      await service.reconcileNativeHistory('chat-1');
      expect(service.listForChat('chat-1')).toEqual([]);
    });
  });

  it('projects following-command batches and inline queued commands as separate inputs', async () => {
    const entries = [
      {
        sessionId: 'session',
        type: 'user',
        uuid: 'original',
        timestamp: '2026-07-21T14:00:00.000Z',
        message: { role: 'user', content: 'original prompt' },
      },
      {
        sessionId: 'session',
        type: 'user',
        uuid: 'following-batch',
        timestamp: '2026-07-21T14:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}first steer` },
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}/second steer` },
          ],
        },
      },
      {
        sessionId: 'session',
        type: 'attachment',
        uuid: 'inline-steer',
        timestamp: '2026-07-21T14:00:02.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: [{
            type: 'text',
            text: `${CLAUDE_STEERING_PROMPT_PREFIX}inline steer`,
          }],
          timestamp: '2026-07-21T14:00:02.500Z',
        },
      },
    ];
    const original = structuredClone(entries);

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);
      expect(messages.map((message) => [message.type, message.content])).toEqual([
        ['user-message', 'original prompt'],
        ['user-message', 'first steer'],
        ['user-message', '/second steer'],
        ['user-message', 'inline steer'],
      ]);
    });
    expect(entries).toEqual(original);
  });
});

describe('Claude JSONL conversion', () => {
  it('preserves AskUserQuestion toolUseResult metadata from JSONL tool results', async () => {
    const lines = [
      JSON.stringify({
        sessionId: 'session-1',
        type: 'assistant',
        timestamp: '2026-02-21T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-question',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Which mode?',
                header: 'Mode',
                multiSelect: false,
                options: [{ label: 'Careful', description: 'Detailed path.' }],
              }],
            },
          }],
        },
      }),
      JSON.stringify({
        sessionId: 'session-1',
        type: 'user',
        timestamp: '2026-02-21T10:00:02.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-question',
            content: 'Your questions have been answered.',
          }],
        },
        toolUseResult: {
          questions: [{ question: 'Which mode?' }],
          answers: { 'Which mode?': 'Careful' },
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadClaudeChatMessages(filePath));
    const result = messages.find((message) => message.type === 'tool-result');

    expect(messages[0].type).toBe('ask-user-question-tool-use');
    expect(result.content.toolUseResult.answers).toEqual({ 'Which mode?': 'Careful' });
  });
});
