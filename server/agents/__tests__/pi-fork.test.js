import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createArtificialNativePath } from '../../chats/artificial-native-path.js';
import { forkPiSession, resolvePiForkSourcePath } from '../pi/pi-fork.js';

const originalEnv = { ...process.env };
let tempRoot;

function sourceSessionPath(sessionDir, sessionId) {
  return path.join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
}

async function writeSourceSession({ sessionDir, sessionId, projectPath }) {
  const sessionPath = sourceSessionPath(sessionDir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const entries = [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: projectPath,
    },
    {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'hello', timestamp: 1767225601000 },
    },
    {
      type: 'message',
      id: 'entry-2',
      parentId: 'entry-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: 1767225602000,
      },
    },
  ];
  await fs.writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return { entries, sessionPath };
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
}

describe('Pi native session fork', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-fork-'));
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, 'agent');
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('creates a native Pi fork from a stored session file path', async () => {
    const projectPath = path.join(tempRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    const { entries, sessionPath } = await writeSourceSession({
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      sessionId: 'source-session',
      projectPath,
    });

    const forked = await forkPiSession({
      agentId: 'pi',
      agentSessionId: 'source-session',
      nativePath: sessionPath,
      projectPath,
      model: 'github-copilot/gpt-5.4',
    });

    expect(forked.agentSessionId).not.toBe('source-session');
    expect(forked.nativePath.startsWith(process.env.PI_CODING_AGENT_SESSION_DIR)).toBe(true);
    expect(forked.nativePath).not.toBe(sessionPath);

    const forkedEntries = await readJsonl(forked.nativePath);
    expect(forkedEntries[0]).toMatchObject({
      type: 'session',
      version: 3,
      id: forked.agentSessionId,
      cwd: projectPath,
      parentSession: sessionPath,
    });
    expect(forkedEntries.slice(1)).toEqual(entries.slice(1));
  });

  it('resolves artificial native paths through the Pi session registry before forking', async () => {
    const projectPath = path.join(tempRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    const { sessionPath } = await writeSourceSession({
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      sessionId: 'source-session',
      projectPath,
    });

    const sourcePath = await resolvePiForkSourcePath({
      agentId: 'pi',
      agentSessionId: 'source-session',
      nativePath: createArtificialNativePath('pi', 'source-session'),
      projectPath,
      model: 'github-copilot/gpt-5.4',
    });

    expect(sourcePath).toBe(sessionPath);
  });

  it('throws a clear error when the source session file cannot be found', async () => {
    const projectPath = path.join(tempRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });

    await expect(forkPiSession({
      agentId: 'pi',
      agentSessionId: 'missing-session',
      nativePath: createArtificialNativePath('pi', 'missing-session'),
      projectPath,
      model: 'github-copilot/gpt-5.4',
    })).rejects.toThrow('Cannot fork Pi session missing-session: native session file was not found.');
  });
});
