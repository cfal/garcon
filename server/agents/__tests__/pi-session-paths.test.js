import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  findPiSessionFileBySessionId,
  piDefaultSessionDir,
  piSessionPathFromHeader,
  resolvePiConfiguredSessionDir,
} from '../pi/pi-session-paths.js';

const originalEnv = { ...process.env };
let tempRoot;

async function writeSessionFile(sessionDir, sessionId, cwd = '/tmp/pi-project') {
  const sessionPath = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionPath, `${[
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd,
    },
    {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'hello', timestamp: 1767225601000 },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return sessionPath;
}

describe('Pi session path utilities', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-session-paths-'));
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, 'agent');
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('computes Pi default session directories and file paths', () => {
    const projectPath = '/tmp/workspace/a:b';
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const header = {
      type: 'session',
      version: 3,
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.123Z',
      cwd: projectPath,
    };

    expect(piDefaultSessionDir(projectPath)).toBe(path.join(agentDir, 'sessions', '--tmp-workspace-a-b--'));
    expect(piSessionPathFromHeader(header)).toBe(path.join(
      agentDir,
      'sessions',
      '--tmp-workspace-a-b--',
      '2026-01-01T00-00-00-123Z_session-1.jsonl',
    ));
  });

  it('honors the configured Pi session directory env var', () => {
    process.env.HOME = tempRoot;
    process.env.PI_CODING_AGENT_SESSION_DIR = '~/pi-sessions';

    expect(resolvePiConfiguredSessionDir('/tmp/project')).toBe(path.join(tempRoot, 'pi-sessions'));
  });

  it('finds a Pi session by id in a configured session directory', async () => {
    const sessionDir = path.join(tempRoot, 'sessions');
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const sessionPath = await writeSessionFile(sessionDir, 'session-2');

    await expect(findPiSessionFileBySessionId('session-2', '/tmp/pi-project')).resolves.toBe(sessionPath);
    await expect(findPiSessionFileBySessionId('missing', '/tmp/pi-project')).resolves.toBeNull();
  });
});
