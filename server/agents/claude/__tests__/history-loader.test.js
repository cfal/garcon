import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadClaudeChatMessages, loadClaudeChatMessagePage } from '../history-loader.js';

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

describe('loadClaudeChatMessagePage', () => {
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

  it('returns null for older tail pages so callers use the full loader', async () => {
    const page = await loadClaudeChatMessagePage('/tmp/missing.jsonl', 2, 1);

    expect(page).toBeNull();
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
