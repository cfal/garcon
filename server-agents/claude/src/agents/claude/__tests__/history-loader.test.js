import { describe, it, expect, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadClaudeChatMessages } from '../history-loader.js';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
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

describe('Claude strict history import', () => {
  it('[TLV5-ADOPT.07-CLAUDE-UNIT-01] rejects incomplete records and recognized content payloads before retry', async () => {
    const invalidEntry = JSON.stringify({ sessionId: 'session-1', type: 'user' });
    await withTempJsonl([invalidEntry], async (filePath) => {
      await expect(loadClaudeChatMessages(filePath, undefined, {
        throwOnError: true,
      })).rejects.toThrow();

      const malformedPartShapes = [
        ['null part', null],
        ['primitive part', 17],
        ['array part', []],
        ['part type missing', {}],
        ['part type empty', { type: '' }],
        ['part type non-string', { type: 17 }],
      ];
      const invalidParts = [
        ...['user', 'assistant'].flatMap((role) => malformedPartShapes.map(
          ([label, part]) => [`${role} ${label}`, role, part],
        )),
        ['user text missing', 'user', { type: 'text' }],
        ['user text non-string', 'user', { type: 'text', text: 17 }],
        ['assistant text missing', 'assistant', { type: 'text' }],
        ['assistant text non-string', 'assistant', { type: 'text', text: 17 }],
        ['thinking missing', 'assistant', { type: 'thinking' }],
        ['thinking non-string', 'assistant', { type: 'thinking', thinking: false }],
      ];
      const invalidContents = [
        ...invalidParts.map(([label, role, part]) => [label, role, [part]]),
        [
          'recognized part before malformed part',
          'assistant',
          [{ type: 'text', text: 'recognized assistant content' }, {}],
        ],
        [
          'malformed part before recognized part',
          'assistant',
          [{}, { type: 'text', text: 'recognized assistant content' }],
        ],
      ];
      const outcomes = [];
      for (const [label, role, content] of invalidContents) {
        await fs.writeFile(filePath, `${JSON.stringify({
          sessionId: 'session-1',
          type: role,
          uuid: 'invalid-part',
          timestamp: '2026-08-16T00:00:00.000Z',
          message: { role, content },
        })}\n`, 'utf8');
        try {
          await loadClaudeChatMessages(filePath, undefined, { throwOnError: true });
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      const topLevelContents = [
        ['user', 'retained top-level user content'],
        ['assistant', 'retained top-level assistant content'],
      ];
      await fs.writeFile(filePath, `${topLevelContents.map(([role, content], index) => JSON.stringify({
        sessionId: 'session-1',
        type: role,
        uuid: `top-level-${role}`,
        timestamp: `2026-08-16T00:00:0${index}.000Z`,
        message: { role, content },
      })).join('\n')}\n`, 'utf8');
      await expect(loadClaudeChatMessages(filePath, undefined, {
        throwOnError: true,
      })).resolves.toMatchObject([
        { type: 'user-message', content: topLevelContents[0][1] },
        { type: 'assistant-message', content: topLevelContents[1][1] },
      ]);

      await fs.writeFile(filePath, [
        JSON.stringify({
          sessionId: 'session-1',
          type: 'queue-operation',
          uuid: 'housekeeping',
          timestamp: '2026-08-16T00:00:00.000Z',
          operation: 'dequeue',
        }),
        JSON.stringify({
          sessionId: 'session-1',
          type: 'user',
          uuid: 'empty-user',
          timestamp: '2026-08-16T00:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'future-housekeeping', payload: { retained: true } },
            ],
          },
        }),
        JSON.stringify({
          sessionId: 'session-1',
          type: 'assistant',
          uuid: 'empty-assistant',
          timestamp: '2026-08-16T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'thinking', thinking: '' },
              { type: 'future-housekeeping', payload: { retained: true } },
            ],
          },
        }),
        ...['user', 'assistant'].map((role, index) => JSON.stringify({
          sessionId: 'session-1',
          type: role,
          uuid: `empty-${role}-array`,
          timestamp: `2026-08-16T00:00:0${index + 3}.000Z`,
          message: { role, content: [] },
        })),
      ].join('\n') + '\n', 'utf8');
      await expect(loadClaudeChatMessages(filePath, undefined, {
        throwOnError: true,
      })).resolves.toEqual([]);

      await fs.writeFile(filePath, '', 'utf8');
      await expect(loadClaudeChatMessages(filePath, undefined, {
        throwOnError: true,
      })).resolves.toEqual([]);
      expect(outcomes).toEqual(invalidContents.map(([label]) => [label, 'rejected']));
    });
  });
});

describe('Claude native user-input conversion', () => {
  it('preserves a captured CLI entity-bearing input with its native identity', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/claude-user-message-entities.jsonl', import.meta.url));
    const content = 'Fixture capture only. Do not inspect or modify files. Preserve this marker as the literal user input in the session transcript: &amp; &lt; &gt; &quot; &#39; <literal>. Reply only: acknowledged';
    const nativeMessages = await loadClaudeChatMessages(fixturePath);
    expect(nativeMessages).toMatchObject([{ type: 'user-message', content }]);
    // Entity-bearing content never participates in identity: provider metadata
    // carries the native uuid used for import deduplication and native forks.
    expect(getNativeMessageSource(nativeMessages[0])).toMatchObject({ entryId: expect.any(String) });
  });

  it('converts a user input persisted only as a queued command attachment', async () => {
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

describe('Claude JSONL microcompaction', () => {
  it('renders a re-appended entry once and keeps the first occurrence identity', async () => {
    // Microcompaction re-appends retained entries with their original uuids,
    // differing only in parent rechaining. The first occurrence is canonical
    // and later copies must not render again.
    const entries = [
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        timestamp: '2026-07-21T14:00:00.000Z',
        message: { role: 'user', content: 'keep me' },
      },
      {
        sessionId: 'session-1',
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        timestamp: '2026-07-21T14:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      },
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'user-1',
        parentUuid: 'assistant-1',
        timestamp: '2026-07-21T14:00:03.000Z',
        message: { role: 'user', content: 'keep me' },
      },
      {
        sessionId: 'session-1',
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        timestamp: '2026-07-21T14:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      },
    ];

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);
      expect(messages.map((message) => [message.type, message.content])).toEqual([
        ['user-message', 'keep me'],
        ['assistant-message', 'answer'],
      ]);
      // The rendered rows keep the first occurrence's native uuid; the
      // provider re-append does not mint a second logical occurrence.
      expect(getNativeMessageSource(messages[0])).toMatchObject({ entryId: 'user-1' });
      expect(getNativeMessageSource(messages[1])).toMatchObject({ entryId: 'assistant-1' });
    });
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
