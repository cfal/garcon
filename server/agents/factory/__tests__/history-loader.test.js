import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { loadFactoryChatMessages } from '../history-loader.js';

const tmpDir = path.join(os.tmpdir(), 'garcon-factory-history-tests');

describe('factory history loader', () => {
  const sessionPath = path.join(tmpDir, 'session.jsonl');

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it('normalizes persisted Factory session messages into canonical chat messages', async () => {
    const lines = [
      JSON.stringify({
        type: 'session_start',
        id: 'sess-1',
        title: 'Factory Session',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-03-29T01:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting repository state' },
            { type: 'tool_use', id: 'tool-1', name: 'LS', input: { path: '/tmp' } },
            { type: 'text', text: 'Found the project files.' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-03-29T01:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: { files: ['package.json'] } },
            { type: 'text', text: 'Continue with the review.' },
          ],
        },
      }),
    ];

    await fs.writeFile(sessionPath, `${lines.join('\n')}\n`, 'utf8');
    const messages = await loadFactoryChatMessages(sessionPath);

    expect(messages).toHaveLength(5);
    expect(messages[0].type).toBe('thinking');
    expect(messages[0].content).toBe('Inspecting repository state');
    expect(messages[1].type).toBe('list-tool-use');
    expect(messages[1].path).toBe('/tmp');
    expect(messages[2].type).toBe('assistant-message');
    expect(messages[2].content).toBe('Found the project files.');
    expect(messages[3].type).toBe('tool-result');
    expect(messages[3].content).toEqual({ files: ['package.json'] });
    expect(messages[4].type).toBe('user-message');
    expect(messages[4].content).toBe('Continue with the review.');
  });
});
