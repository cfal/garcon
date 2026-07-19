import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  findFactorySessionFileBySessionId,
  getFactoryPreviewFromSessionPath,
  loadFactoryChatMessages,
} from '../history-loader.js';

let tmpDir;
let originalFactoryHomeOverride;

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry));
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

describe('factory history loader', () => {
  beforeEach(async () => {
    originalFactoryHomeOverride = process.env.FACTORY_HOME_OVERRIDE;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-factory-history-tests-'));
  });

  afterEach(async () => {
    if (originalFactoryHomeOverride === undefined) {
      delete process.env.FACTORY_HOME_OVERRIDE;
    } else {
      process.env.FACTORY_HOME_OVERRIDE = originalFactoryHomeOverride;
    }
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it('normalizes persisted Factory session messages into visible canonical messages', async () => {
    const sessionPath = path.join(tmpDir, 'session.jsonl');
    await writeJsonl(sessionPath, [
      {
        type: 'session_start',
        id: 'sess-1',
        title: 'Factory Session',
        timestamp: '2026-03-29T00:59:00.000Z',
      },
      {
        type: 'message',
        timestamp: '2026-03-29T00:59:30.000Z',
        message: {
          role: 'user',
          visibility: 'llm_only',
          content: [
            { type: 'text', text: '<system-reminder>internal</system-reminder>' },
            { type: 'text', text: 'hidden provider prompt' },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-03-29T01:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting repository state' },
            { type: 'tool_use', id: 'tool-1', name: 'LS', input: { path: '/tmp' } },
            { type: 'text', text: 'hidden reasoning</think>Found the project files.' },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-03-29T01:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: { files: ['package.json'] } },
            { type: 'text', text: '<system-reminder>ignore</system-reminder>' },
            { type: 'text', text: 'Continue with the review.' },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-03-29T01:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hidden reasoning</think>Done.' },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-03-29T01:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hidden only</think>' },
          ],
        },
      },
      'not-json',
    ]);

    const messages = await loadFactoryChatMessages(sessionPath);

    expect(messages).toHaveLength(6);
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
    expect(messages[5].type).toBe('assistant-message');
    expect(messages[5].content).toBe('Done.');
    expect(getNativeMessageSource(messages[2])).toMatchObject({ lineNumber: 3 });
    expect(getNativeMessageSource(messages[4])).toMatchObject({ lineNumber: 4 });

    const preview = await getFactoryPreviewFromSessionPath(sessionPath);
    expect(preview).toEqual({
      createdAt: '2026-03-29T00:59:00.000Z',
      firstMessage: 'Continue with the review.',
      lastActivity: '2026-03-29T01:00:02.000Z',
      lastMessage: 'Done.',
    });
  });

  it('finds Factory session files under FACTORY_HOME_OVERRIDE', async () => {
    process.env.FACTORY_HOME_OVERRIDE = tmpDir;
    const sessionPath = path.join(tmpDir, '.factory', 'sessions', '-garcon', 'sess-2.jsonl');
    const indexPath = path.join(tmpDir, '.factory', 'cache', 'session-discovery-index.json');

    await writeJsonl(sessionPath, [{ type: 'session_start', id: 'sess-2' }]);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify({
      entries: {
        'sess-2': {
          id: 'sess-2',
          sessionPath,
        },
      },
    }), 'utf8');

    expect(await findFactorySessionFileBySessionId('sess-2')).toBe(sessionPath);

    await fs.rm(indexPath);
    expect(await findFactorySessionFileBySessionId('sess-2')).toBe(sessionPath);
  });
});
