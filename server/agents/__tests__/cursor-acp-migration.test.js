import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { ChatRegistry } from '../../chats/store.js';
import { migrateCursorAcpSessionsToStreamJson } from '../cursor/cursor-acp-migration.js';
import {
  cursorLegacyAcpStoreDbPath,
  cursorStreamJsonStoreDbPath,
} from '../cursor/history-loader.js';

let tempRoot;
let workspaceDir;
let cursorHome;

async function readRegistryFile() {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
}

describe('Cursor ACP session migration', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cursor-acp-migration-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    cursorHome = path.join(tempRoot, 'cursor-home');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('copies ACP transcript databases and converts Cursor native paths to stream-json', async () => {
    const sessionId = 'cursor-session-1';
    const projectPath = path.join(tempRoot, 'project');
    const sourceDbPath = cursorLegacyAcpStoreDbPath(sessionId, cursorHome);
    const targetDbPath = cursorStreamJsonStoreDbPath(sessionId, projectPath, cursorHome);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'legacy db');
    await fs.writeFile(`${sourceDbPath}-wal`, 'legacy wal');

    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        cursorChat: {
          agentId: 'cursor',
          agentSessionId: sessionId,
          nativePath: `!cursor-acp:${sessionId}`,
          projectPath,
          tags: [],
          model: 'default',
        },
      },
    }, null, 2));

    const registry = new ChatRegistry(workspaceDir);
    await registry.init();

    const result = await migrateCursorAcpSessionsToStreamJson(registry, cursorHome);

    expect(result).toEqual({
      converted: 1,
      copied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat('cursorChat')?.nativePath).toBe(`!cursor-stream-json:${sessionId}`);
    expect(await fs.readFile(targetDbPath, 'utf8')).toBe('legacy db');
    expect(await fs.readFile(`${targetDbPath}-wal`, 'utf8')).toBe('legacy wal');

    const persisted = await readRegistryFile();
    expect(persisted.sessions.cursorChat.nativePath).toBe(`!cursor-stream-json:${sessionId}`);
  });

  it('converts native paths when the stream-json transcript already exists without overwriting it', async () => {
    const sessionId = 'cursor-session-2';
    const projectPath = path.join(tempRoot, 'project');
    const sourceDbPath = cursorLegacyAcpStoreDbPath(sessionId, cursorHome);
    const targetDbPath = cursorStreamJsonStoreDbPath(sessionId, projectPath, cursorHome);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.mkdir(path.dirname(targetDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'legacy db');
    await fs.writeFile(targetDbPath, 'stream db');

    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        cursorChat: {
          agentId: 'cursor',
          agentSessionId: sessionId,
          nativePath: `!cursor-acp:${sessionId}`,
          projectPath,
          tags: [],
          model: 'default',
        },
      },
    }, null, 2));

    const registry = new ChatRegistry(workspaceDir);
    await registry.init();

    const result = await migrateCursorAcpSessionsToStreamJson(registry, cursorHome);

    expect(result).toEqual({
      converted: 1,
      copied: 0,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat('cursorChat')?.nativePath).toBe(`!cursor-stream-json:${sessionId}`);
    expect(await fs.readFile(targetDbPath, 'utf8')).toBe('stream db');
  });

  it('leaves non-ACP Cursor sessions and other agents unchanged', async () => {
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        cursorStream: {
          agentId: 'cursor',
          agentSessionId: 'cursor-stream',
          nativePath: '!cursor-stream-json:cursor-stream',
          projectPath: '/p',
          tags: [],
          model: 'default',
        },
        ampChat: {
          agentId: 'amp',
          agentSessionId: 'amp-thread',
          nativePath: '!cursor-acp:not-a-cursor-chat',
          projectPath: '/p',
          tags: [],
          model: 'default',
        },
      },
    }, null, 2));

    const registry = new ChatRegistry(workspaceDir);
    await registry.init();

    const result = await migrateCursorAcpSessionsToStreamJson(registry, cursorHome);

    expect(result).toEqual({
      converted: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat('cursorStream')?.nativePath).toBe('!cursor-stream-json:cursor-stream');
    expect(registry.getChat('ampChat')?.nativePath).toBe('!cursor-acp:not-a-cursor-chat');
  });
});
