import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { ChatRegistry } from '../../../../../../server/chats/store.js';
import { migrateCursorStreamJsonSessionsToAcp } from '../cursor-acp-migration.js';
import {
  cursorAcpStoreDbPath,
  cursorStreamJsonStoreDbPath,
} from '../history-loader.js';

const CURSOR_CHAT_ID = '1783725900000500';
const CURSOR_STREAM_CHAT_ID = '1783725900000501';
const AMP_CHAT_ID = '1783725900000502';

let tempRoot;
let workspaceDir;
let cursorHome;

async function readRegistryFile() {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
}

describe('Cursor stream-json to ACP session migration', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cursor-acp-migration-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    cursorHome = path.join(tempRoot, 'cursor-home');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('copies stream-json transcript databases and converts Cursor native paths to ACP', async () => {
    const sessionId = 'cursor-session-1';
    const projectPath = path.join(tempRoot, 'project');
    const sourceDbPath = cursorStreamJsonStoreDbPath(sessionId, projectPath, cursorHome);
    const targetDbPath = cursorAcpStoreDbPath(sessionId, cursorHome);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'stream db');
    await fs.writeFile(`${sourceDbPath}-wal`, 'stream wal');

    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        [CURSOR_CHAT_ID]: {
          agentId: 'cursor',
          agentSessionId: sessionId,
          nativePath: `!cursor-stream-json:${sessionId}`,
          projectPath,
          tags: [],
          model: 'default',
        },
      },
    }, null, 2));

    const registry = new ChatRegistry(workspaceDir);
    await registry.init();

    const result = await migrateCursorStreamJsonSessionsToAcp(registry, cursorHome);

    expect(result).toEqual({
      converted: 1,
      copied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat(CURSOR_CHAT_ID)?.nativePath).toBe(`!cursor-acp:${sessionId}`);
    expect(await fs.readFile(targetDbPath, 'utf8')).toBe('stream db');
    expect(await fs.readFile(`${targetDbPath}-wal`, 'utf8')).toBe('stream wal');

    const persisted = await readRegistryFile();
    expect(persisted.sessions[CURSOR_CHAT_ID].nativePath).toBe(`!cursor-acp:${sessionId}`);
  });

  it('converts native paths when the ACP transcript already exists without overwriting it', async () => {
    const sessionId = 'cursor-session-2';
    const projectPath = path.join(tempRoot, 'project');
    const sourceDbPath = cursorStreamJsonStoreDbPath(sessionId, projectPath, cursorHome);
    const targetDbPath = cursorAcpStoreDbPath(sessionId, cursorHome);
    await fs.mkdir(path.dirname(sourceDbPath), { recursive: true });
    await fs.mkdir(path.dirname(targetDbPath), { recursive: true });
    await fs.writeFile(sourceDbPath, 'stream db');
    await fs.writeFile(targetDbPath, 'acp db');

    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        [CURSOR_CHAT_ID]: {
          agentId: 'cursor',
          agentSessionId: sessionId,
          nativePath: `!cursor-stream-json:${sessionId}`,
          projectPath,
          tags: [],
          model: 'default',
        },
      },
    }, null, 2));

    const registry = new ChatRegistry(workspaceDir);
    await registry.init();

    const result = await migrateCursorStreamJsonSessionsToAcp(registry, cursorHome);

    expect(result).toEqual({
      converted: 1,
      copied: 0,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat(CURSOR_CHAT_ID)?.nativePath).toBe(`!cursor-acp:${sessionId}`);
    expect(await fs.readFile(targetDbPath, 'utf8')).toBe('acp db');
  });

  it('leaves ACP Cursor sessions and other agents unchanged', async () => {
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        [CURSOR_STREAM_CHAT_ID]: {
          agentId: 'cursor',
          agentSessionId: 'cursor-acp',
          nativePath: '!cursor-acp:cursor-acp',
          projectPath: '/p',
          tags: [],
          model: 'default',
        },
        [AMP_CHAT_ID]: {
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

    const result = await migrateCursorStreamJsonSessionsToAcp(registry, cursorHome);

    expect(result).toEqual({
      converted: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
    });
    expect(registry.getChat(CURSOR_STREAM_CHAT_ID)?.nativePath).toBe('!cursor-acp:cursor-acp');
    expect(registry.getChat(AMP_CHAT_ID)?.nativePath).toBe('!cursor-acp:not-a-cursor-chat');
  });
});
