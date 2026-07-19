import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { cursorAcpStoreDbPath, cursorStreamJsonStoreDbPath } from '../history-loader.js';
import { forkCursorAcpSession } from '../cursor-session-store.js';

let tempRoot;

describe('Cursor session forking', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cursor-agent-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('advertises fork support and forks Cursor storage into an ACP session', async () => {
    const workspaceDir = path.join(tempRoot, 'workspace');
    const cursorHome = path.join(tempRoot, 'cursor-home');
    const sourceSessionId = 'source-session';
    const targetSessionId = 'target-session';
    const sourceDbPath = cursorStreamJsonStoreDbPath(sourceSessionId, workspaceDir, cursorHome);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'source db');

    const forked = await forkCursorAcpSession({
      projectPath: workspaceDir,
      agentSessionId: sourceSessionId,
      nativePath: `!cursor-stream-json:${sourceSessionId}`,
    }, {
      cursorHome,
      createSessionId: () => targetSessionId,
    });

    expect(forked).toEqual({
      agentSessionId: targetSessionId,
      nativePath: `!cursor-acp:${targetSessionId}`,
    });
    expect(await fs.readFile(cursorAcpStoreDbPath(targetSessionId, cursorHome), 'utf8'))
      .toBe('source db');
  });
});
