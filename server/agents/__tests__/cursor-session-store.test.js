import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { forkCursorAcpSession } from '../cursor/cursor-session-store.js';
import {
  cursorAcpSessionDirPath,
  cursorAcpStoreDbPath,
  cursorStreamJsonStoreDbPath,
} from '../cursor/history-loader.js';

let tempRoot;

describe('Cursor ACP session store', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cursor-session-store-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('forks a Cursor ACP session by copying the full session directory to a new id', async () => {
    const projectPath = path.join(tempRoot, 'project');
    const sourceSessionId = 'source-session';
    const targetSessionId = 'target-session';
    const sourceDbPath = cursorAcpStoreDbPath(sourceSessionId, tempRoot);
    const targetDbPath = cursorAcpStoreDbPath(targetSessionId, tempRoot);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'source db');
    await fs.writeFile(path.join(path.dirname(sourceDbPath), 'meta.json'), '{"hasConversation":true}');
    await fs.writeFile(path.join(path.dirname(sourceDbPath), 'store.db-wal'), 'source wal');

    const result = await forkCursorAcpSession({
      agentSessionId: sourceSessionId,
      nativePath: `!cursor-acp:${sourceSessionId}`,
      projectPath,
    }, {
      cursorHome: tempRoot,
      createSessionId: () => targetSessionId,
    });

    expect(result).toEqual({
      agentSessionId: targetSessionId,
      nativePath: `!cursor-acp:${targetSessionId}`,
    });
    expect(await fs.readFile(targetDbPath, 'utf8')).toBe('source db');
    expect(await fs.readFile(path.join(path.dirname(targetDbPath), 'meta.json'), 'utf8')).toBe('{"hasConversation":true}');
    expect(await fs.readFile(path.join(path.dirname(targetDbPath), 'store.db-wal'), 'utf8')).toBe('source wal');
  });

  it('recovers the source session id from nativePath when agentSessionId is absent', async () => {
    const projectPath = path.join(tempRoot, 'project');
    const sourceSessionId = 'native-path-source';
    const targetSessionId = 'native-path-target';
    const sourceDbPath = cursorAcpStoreDbPath(sourceSessionId, tempRoot);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'source db');

    const result = await forkCursorAcpSession({
      agentSessionId: null,
      nativePath: `!cursor-acp:${sourceSessionId}`,
      projectPath,
    }, {
      cursorHome: tempRoot,
      createSessionId: () => targetSessionId,
    });

    expect(result.agentSessionId).toBe(targetSessionId);
    expect(await fs.readFile(cursorAcpStoreDbPath(targetSessionId, tempRoot), 'utf8')).toBe('source db');
  });

  it('can fork an unmigrated stream-json source into an ACP target', async () => {
    const projectPath = path.join(tempRoot, 'project');
    const sourceSessionId = 'stream-source';
    const targetSessionId = 'acp-target';
    const sourceDbPath = cursorStreamJsonStoreDbPath(sourceSessionId, projectPath, tempRoot);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'source db');
    await fs.writeFile(`${sourceDbPath}-wal`, 'source wal');

    const result = await forkCursorAcpSession({
      agentSessionId: sourceSessionId,
      nativePath: `!cursor-stream-json:${sourceSessionId}`,
      projectPath,
    }, {
      cursorHome: tempRoot,
      createSessionId: () => targetSessionId,
    });

    expect(result).toEqual({
      agentSessionId: targetSessionId,
      nativePath: `!cursor-acp:${targetSessionId}`,
    });
    expect(await fs.readFile(cursorAcpStoreDbPath(targetSessionId, tempRoot), 'utf8')).toBe('source db');
    expect(await fs.readFile(`${cursorAcpStoreDbPath(targetSessionId, tempRoot)}-wal`, 'utf8')).toBe('source wal');
  });

  it('does not overwrite an existing target session directory', async () => {
    const projectPath = path.join(tempRoot, 'project');
    const sourceSessionId = 'source-session';
    const targetSessionId = 'target-session';
    const sourceDbPath = cursorAcpStoreDbPath(sourceSessionId, tempRoot);
    const targetDir = cursorAcpSessionDirPath(targetSessionId, tempRoot);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'source db');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'store.db'), 'existing db');

    await expect(forkCursorAcpSession({
      agentSessionId: sourceSessionId,
      nativePath: `!cursor-acp:${sourceSessionId}`,
      projectPath,
    }, {
      cursorHome: tempRoot,
      createSessionId: () => targetSessionId,
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(targetDir, 'store.db'), 'utf8')).toBe('existing db');
  });
});
