import { describe, it, expect, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getClaudePreviewFromNativePath,
  getClaudeSessionMessagesFromNativePath,
  loadClaudeChatMessages,
  loadClaudeChatMessagePage,
} from '../history-loader.js';
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
      clientMessageId: 'a4912601-44aa-469d-b00e-3eee75dd027e',
      createdAt: '2026-07-17T15:20:02.700Z',
    });

    const nativeMessages = await loadClaudeChatMessages(fixturePath);
    expect(nativeMessages).toMatchObject([{
      type: 'user-message',
      content,
      metadata: { upstreamRequestId: 'a4912601-44aa-469d-b00e-3eee75dd027e' },
    }]);
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
        clientMessageId: 'queued-1',
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
        clientMessageId: 'following-batch',
        createdAt: '2026-07-21T14:00:00.500Z',
        deliveryStatus: 'accepted',
      });
      await service.register('chat-1', filtered, {
        clientRequestId: 'request-filtered',
        clientMessageId: 'following-batch',
        createdAt: '2026-07-21T14:00:00.500Z',
        deliveryStatus: 'accepted',
      });
      await service.reconcileNativeHistory('chat-1');
      expect(service.listForChat('chat-1')).toEqual([]);

      const preview = await getClaudePreviewFromNativePath(filePath);
      expect(preview).toMatchObject({
        firstMessage: spaced,
        lastMessage: '> <system-reminder>literal guidance</system-reminder>',
      });
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

      const page = await loadClaudeChatMessagePage(filePath, 2, 1);
      expect(page.messages.map((message) => message.content)).toEqual([
        'first steer',
        '/second steer',
      ]);
      expect(page.total).toBe(4);
    });
    expect(entries).toEqual(original);
  });

  it('normalizes steering previews without changing ordinary strings', async () => {
    const ordinaryPrefixText = `${CLAUDE_STEERING_PROMPT_PREFIX}ordinary string`;
    const entries = [
      {
        sessionId: 'session',
        type: 'user',
        uuid: 'ordinary',
        timestamp: '2026-07-21T14:00:00.000Z',
        message: { role: 'user', content: ordinaryPrefixText },
      },
      {
        sessionId: 'session',
        type: 'user',
        uuid: 'steering-batch',
        timestamp: '2026-07-21T14:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}first` },
            { type: 'text', text: `${CLAUDE_STEERING_PROMPT_PREFIX}last` },
          ],
        },
      },
    ];

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const preview = await getClaudePreviewFromNativePath(filePath);
      expect(preview).toMatchObject({
        firstMessage: ordinaryPrefixText.trim(),
        lastMessage: '> last',
      });
      expect(preview.lastMessage).not.toContain(CLAUDE_STEERING_PROMPT_PREFIX);
    });
  });
});

describe('getClaudePreviewFromNativePath', () => {
  it('preserves an untimestamped first user message while finding session time', async () => {
    const entries = [
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'user-1',
        message: { role: 'user', content: 'first prompt' },
      },
      {
        sessionId: 'session-1',
        type: 'user',
        uuid: 'user-2',
        timestamp: '2026-07-21T14:00:01.000Z',
        message: { role: 'user', content: 'later prompt' },
      },
    ];
    const logger = {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };

    await withTempJsonl(entries.map(JSON.stringify), async (filePath) => {
      const preview = await getClaudePreviewFromNativePath(filePath, logger);
      expect(preview).toMatchObject({
        firstMessage: 'first prompt',
        createdAt: '2026-07-21T14:00:01.000Z',
      });
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});

describe('loadClaudeChatMessagePage', () => {
  it('loads only the first value from a concatenated physical line', async () => {
    const user = {
      sessionId: 'session-1',
      type: 'user',
      uuid: 'entry-1',
      timestamp: '2026-02-21T09:00:00.000Z',
      message: { role: 'user', content: 'recovered prompt' },
    };
    const mode = { sessionId: 'session-1', type: 'mode', mode: 'normal' };
    const assistant = {
      sessionId: 'session-1',
      type: 'assistant',
      uuid: 'entry-2',
      timestamp: '2026-02-21T09:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'later reply' }] },
    };

    await withTempJsonl([
      `${JSON.stringify(user)}${JSON.stringify(mode)}`,
      '{bad}',
      JSON.stringify(assistant),
    ], async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);
      const page = await loadClaudeChatMessagePage(filePath, 10, 0);
      const raw = await getClaudeSessionMessagesFromNativePath(filePath);

      expect(messages.map((message) => message.content)).toEqual(['recovered prompt', 'later reply']);
      expect(getNativeMessageSource(messages[0])).toEqual({ entryId: 'entry-1', lineNumber: 1 });
      expect(page.messages.map((message) => message.content)).toEqual(['recovered prompt', 'later reply']);
      expect(raw.map((entry) => entry.type)).toEqual(['user', 'assistant']);
    });
  });

  it('renders microcompaction re-appends once and keeps page-scan parity', async () => {
    const entry = (value) => JSON.stringify({ sessionId: 'session-1', ...value });
    const user = {
      type: 'user', uuid: 'u-user', parentUuid: null,
      timestamp: '2026-07-29T00:34:08.457Z',
      message: { role: 'user', content: 'run the build' },
    };
    const assistant = {
      type: 'assistant', uuid: 'u-assistant', parentUuid: 'u-user',
      timestamp: '2026-07-29T00:34:09.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'building' }] },
    };
    const lines = [
      entry(user),
      entry(assistant),
      entry({ ...user, slug: 'compacted-slug' }),
      entry({ ...assistant, parentUuid: 'u-user' }),
      entry({
        type: 'system', subtype: 'compact_boundary', uuid: 'u-boundary',
        parentUuid: 'u-assistant', timestamp: '2026-07-29T07:27:07.261Z',
        compactMetadata: { trigger: 'auto', pre_tokens: 200000 },
      }),
      entry({
        type: 'user', uuid: 'u-summary', parentUuid: 'u-assistant',
        isCompactSummary: true, timestamp: '2026-07-29T07:27:07.259Z',
        message: { role: 'user', content: 'summary of the build conversation' },
      }),
      entry({
        type: 'assistant', uuid: 'u-after', parentUuid: 'u-summary',
        timestamp: '2026-07-29T07:28:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
      }),
    ];

    await withTempJsonl(lines, async (filePath) => {
      const full = await loadClaudeChatMessages(filePath);
      const page = await loadClaudeChatMessagePage(filePath, 10, 0);

      expect(full.map((message) => message.type)).toEqual([
        'user-message',
        'assistant-message',
        'compaction',
        'assistant-message',
      ]);
      expect(full[0].content).toBe('run the build');
      expect(full[1].content).toBe('building');
      expect(full[2].trigger).toBe('auto');
      expect(full[3].content).toBe('continuing');
      expect(page.total).toBe(full.length);
      expect(page.messages.map((message) => message.type)).toEqual(full.map((message) => message.type));
      expect(page.revision).toBe(transcriptRevision(full));
    });
  });

  it('loads the initial page from tail JSONL entries', async () => {
    const lines = Array.from({ length: 6 }, (_, index) => JSON.stringify({
      sessionId: 'session-1',
      type: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: `2026-02-21T10:00:0${index}.000Z`,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index % 2 === 0 ? `prompt ${index}` : [{ type: 'text', text: `reply ${index}` }],
      },
    }));

    const page = await withTempJsonl(lines, (filePath) => loadClaudeChatMessagePage(filePath, 2, 0));

    expect(page).toMatchObject({ total: 6, hasMore: true, offset: 0, limit: 2 });
    expect(page.messages.map((message) => message.content)).toEqual(['prompt 4', 'reply 5']);
  });

  it('uses deterministic source timestamps when native timestamps are missing or non-string', async () => {
    const lines = [undefined, 123].map((timestamp, index) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      ...(timestamp === undefined ? {} : { timestamp }),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${index}` }],
      },
    }));

    await withTempJsonl(lines, async (filePath) => {
      const first = await loadClaudeChatMessages(filePath);
      const second = await loadClaudeChatMessages(filePath);
      const firstPage = await loadClaudeChatMessagePage(filePath, 2, 0);
      const secondPage = await loadClaudeChatMessagePage(filePath, 2, 0);

      expect(second).toEqual(first);
      expect(first.map((message) => message.timestamp)).toEqual([
        '2000-01-01T00:00:00.001Z',
        '2000-01-01T00:00:00.002Z',
      ]);
      expect(secondPage.revision).toBe(firstPage.revision);
      expect(firstPage.revision).toBe(transcriptRevision(first));
    });
  });

  it('loads older pages with an exact total without retaining full messages', async () => {
    const lines = Array.from({ length: 600 }, (_, index) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 1, 21, 10, 0, index)).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${index} ${'x'.repeat(800)}` }],
      },
    }));

    const page = await withTempJsonl(lines, (filePath) => loadClaudeChatMessagePage(filePath, 3, 5));

    expect(page).toMatchObject({ total: 600, hasMore: true, offset: 5, limit: 3 });
    expect(page.messages.map((message) => message.content.slice(0, 9))).toEqual([
      'reply 592', 'reply 593', 'reply 594',
    ]);
  });

  it('keeps canonical whole-transcript revisions across windows and off-window changes', async () => {
    const timestamps = [5, 0, 1, 2, 3, 4];
    const lines = timestamps.map((second, index) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      timestamp: `2026-02-21T10:00:0${second}.000Z`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${index}` }],
      },
    }));

    await withTempJsonl(lines, async (filePath) => {
      const full = await loadClaudeChatMessages(filePath);
      const latestPage = await loadClaudeChatMessagePage(filePath, 2, 0);
      for (const offset of [0, 2]) {
        const page = await loadClaudeChatMessagePage(filePath, 2, offset);
        const end = full.length - offset;
        expect(page.messages).toEqual(full.slice(end - 2, end));
        expect(page.revision).toBe(transcriptRevision(full));
      }

      const changedLines = [...lines];
      const changedEntry = JSON.parse(changedLines[1]);
      changedEntry.message.content = [{ type: 'text', text: 'changed outside the latest page' }];
      changedLines[1] = JSON.stringify(changedEntry);
      await fs.writeFile(filePath, `${changedLines.join('\n')}\n`, 'utf8');

      const changedFull = await loadClaudeChatMessages(filePath);
      const changedPage = await loadClaudeChatMessagePage(filePath, 2, 0);
      expect(changedPage.messages).toEqual(latestPage.messages);
      expect(changedPage.revision).not.toBe(latestPage.revision);
      expect(changedPage.revision).toBe(transcriptRevision(changedFull));
    });
  });

  it('matches full ordering with mixed invalid and missing timestamps', async () => {
    const timestamps = ['2026-02-21T10:00:03.000Z', 'invalid', undefined,
      '2026-02-21T10:00:01.000Z', '2026-02-21T10:00:02.000Z'];
    const lines = timestamps.map((timestamp, index) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      ...(timestamp === undefined ? {} : { timestamp }),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${index}` }],
      },
    }));

    await withTempJsonl(lines, async (filePath) => {
      const expected = (await loadClaudeChatMessages(filePath)).map((message) => message.content);
      for (const offset of [0, 1, 3]) {
        const page = await loadClaudeChatMessagePage(filePath, 2, offset);
        const end = expected.length - offset;
        expect(page.messages.map((message) => message.content)).toEqual(
          expected.slice(Math.max(0, end - 2), end),
        );
      }
    });
  });

  it('preserves stable ordering for equal timestamps at multiple offsets', async () => {
    const lines = Array.from({ length: 6 }, (_, index) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      timestamp: '2026-02-21T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${index}` }],
      },
    }));

    await withTempJsonl(lines, async (filePath) => {
      for (const offset of [0, 2, 4]) {
        const page = await loadClaudeChatMessagePage(filePath, 2, offset);
        expect(page.messages.map((message) => message.content)).toEqual(
          [`reply ${4 - offset}`, `reply ${5 - offset}`],
        );
      }
    });
  });

  it('changes revisions when same-source message parts are reversed', async () => {
    const entry = (content) => JSON.stringify({
      sessionId: 'session-1',
      type: 'assistant',
      timestamp: '2026-02-21T10:00:00.000Z',
      message: { role: 'assistant', content },
    });
    const thinking = { type: 'thinking', thinking: 'reasoning' };
    const text = { type: 'text', text: 'answer' };
    let firstRevision;
    await withTempJsonl([entry([thinking, text])], async (filePath) => {
      firstRevision = (await loadClaudeChatMessagePage(filePath, 2, 0)).revision;
    });
    await withTempJsonl([entry([text, thinking])], async (filePath) => {
      const secondRevision = (await loadClaudeChatMessagePage(filePath, 2, 0)).revision;
      expect(secondRevision).not.toBe(firstRevision);
    });
  });

  it('binds each compaction metadata tuple to its boundary position', async () => {
    const lines = (swap) => [
      JSON.stringify({
        sessionId: 'session-1', type: 'system', subtype: 'compact_boundary',
        timestamp: '2026-02-21T10:00:01.000Z',
        compactMetadata: swap
          ? { trigger: 'auto', preTokens: 200, postTokens: 20 }
          : { trigger: 'manual', preTokens: 100, postTokens: 10 },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'user', isCompactSummary: true,
        timestamp: '2026-02-21T10:00:02.000Z',
        message: { role: 'user', content: 'Summary: first' },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'system', subtype: 'compact_boundary',
        timestamp: '2026-02-21T10:00:03.000Z',
        compactMetadata: swap
          ? { trigger: 'manual', preTokens: 100, postTokens: 10 }
          : { trigger: 'auto', preTokens: 200, postTokens: 20 },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'user', isCompactSummary: true,
        timestamp: '2026-02-21T10:00:04.000Z',
        message: { role: 'user', content: 'Summary: second' },
      }),
    ];
    let firstRevision;
    await withTempJsonl(lines(false), async (filePath) => {
      firstRevision = (await loadClaudeChatMessagePage(filePath, 2, 0)).revision;
    });
    await withTempJsonl(lines(true), async (filePath) => {
      const secondRevision = (await loadClaudeChatMessagePage(filePath, 2, 0)).revision;
      expect(secondRevision).not.toBe(firstRevision);
    });
  });

  it('changes revisions when boundary timestamps change compaction pairing', async () => {
    const lines = (reverseBoundaries) => [
      JSON.stringify({
        sessionId: 'session-1', type: 'system', subtype: 'compact_boundary',
        timestamp: reverseBoundaries
          ? '2026-02-21T10:00:03.000Z' : '2026-02-21T10:00:01.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 100, postTokens: 10 },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'user', isCompactSummary: true,
        timestamp: '2026-02-21T10:00:02.000Z',
        message: { role: 'user', content: 'Summary: first' },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'system', subtype: 'compact_boundary',
        timestamp: reverseBoundaries
          ? '2026-02-21T10:00:01.000Z' : '2026-02-21T10:00:03.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 200, postTokens: 20 },
      }),
      JSON.stringify({
        sessionId: 'session-1', type: 'user', isCompactSummary: true,
        timestamp: '2026-02-21T10:00:04.000Z',
        message: { role: 'user', content: 'Summary: second' },
      }),
    ];
    const load = (reverseBoundaries) => withTempJsonl(lines(reverseBoundaries), async (filePath) => {
      const messages = await loadClaudeChatMessages(filePath);
      const page = await loadClaudeChatMessagePage(filePath, 2, 0);
      return {
        metadata: messages.map(({ trigger, preTokens, postTokens }) => ({
          trigger, preTokens, postTokens,
        })),
        revision: page.revision,
        fullRevision: transcriptRevision(messages),
      };
    });

    const first = await load(false);
    const second = await load(true);

    expect(second.metadata).not.toEqual(first.metadata);
    expect(second.revision).not.toBe(first.revision);
    expect(first.revision).toBe(first.fullRevision);
    expect(second.revision).toBe(second.fullRevision);
  });

  it('preserves compaction pairing with a one-message bounded page', async () => {
    const lines = Array.from({ length: 200 }, (_, index) => [
      JSON.stringify({
        sessionId: 'session-1',
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: new Date(Date.UTC(2026, 1, 21, 10, 0, index * 2 + 1)).toISOString(),
        compactMetadata: { trigger: index % 2 ? 'auto' : 'manual', preTokens: index },
      }),
      JSON.stringify({
        sessionId: 'session-1',
        type: 'user',
        isCompactSummary: true,
        timestamp: new Date(Date.UTC(2026, 1, 21, 10, 0, index * 2)).toISOString(),
        message: { role: 'user', content: `Summary: compaction ${index}` },
      }),
    ]).flat();

    await withTempJsonl(lines, async (filePath) => {
      const full = await loadClaudeChatMessages(filePath);
      const page = await loadClaudeChatMessagePage(filePath, 1, 0);
      expect(page.messages).toEqual(full.slice(-1));
    });
  });

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
