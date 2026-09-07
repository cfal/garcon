import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentSettingsEnvelope } from '../../../common/agent-integration.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

interface PersistedClaudeChat {
  projectPath: string;
  agentSessionId: string;
  nativeSession: {
    ownerId: string;
    schemaVersion: number;
    value: {
      path: string;
      agentSessionId: string;
    };
  };
}

describe('Claude project path relocation', () => {
  test('moves native history before resuming from a new project and survives restart', async () => {
    const environment: Record<string, string> = {};
    await withIntegrationFixture(
      'claude-project-path-relocation',
      async (fixture) => {
        const projectA = join(fixture.dirs.project, 'a');
        const projectB = join(fixture.dirs.project, 'b');
        await Promise.all([
          mkdir(projectA, { recursive: true }),
          mkdir(projectB, { recursive: true }),
        ]);

        const claude = (await fixture.client.listAgentCatalog()).agents.find(
          (agent) => agent.id === 'claude',
        );
        if (!claude) throw new Error('Claude integration is missing from the agent catalog');

        const chatId = fixture.newChatId();
        const first = await fixture.client.startChat({
          origin: 'interactive',
          clientRequestId: randomUUID(),
          clientMessageId: randomUUID(),
          chatId,
          agentId: claude.id,
          projectPath: projectA,
          model: claude.defaultModel,
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettings: claude.defaultSettings,
          command: 'relocation-turn-a',
        });
        expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe(
          'agent-run-finished',
        );

        const before = await waitForPersistedNativeSession({
          directories: fixture.dirs,
          chatId,
          agentId: 'claude',
        }) as unknown as PersistedClaudeChat;
        const sourcePath = before.nativeSession.value.path;
        const sourceQueuePath = queuePath(sourcePath, before.agentSessionId);
        const sourceSupportPath = supportPath(sourcePath, before.agentSessionId);
        await Promise.all([
          access(sourcePath),
          access(sourceQueuePath),
          access(sourceSupportPath),
        ]);

        const updated = await fixture.client.updateProjectPath({
          chatId,
          projectPath: projectB,
        });
        expect(updated).toMatchObject({
          success: true,
          chatId,
          projectPath: projectB,
          previousProjectPath: projectA,
        });

        const relocated = await readClaudeChat(fixture.dirs.workspace, chatId);
        const targetPath = relocated.nativeSession.value.path;
        expect(relocated).toMatchObject({
          projectPath: projectB,
          agentSessionId: before.agentSessionId,
          nativeSession: {
            ownerId: 'claude',
            schemaVersion: 1,
            value: { agentSessionId: before.agentSessionId },
          },
        });
        expect(targetPath).not.toBe(sourcePath);
        await Promise.all([
          access(targetPath),
          access(queuePath(targetPath, before.agentSessionId)),
          access(supportPath(targetPath, before.agentSessionId)),
        ]);
        await expectMissing(sourcePath);
        await expectMissing(sourceQueuePath);
        await expectMissing(sourceSupportPath);

        const second = await runClaudeTurn(fixture, {
          chatId,
          content: 'relocation-turn-b',
          model: claude.defaultModel,
          settings: claude.defaultSettings,
        });
        expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type).toBe(
          'agent-run-finished',
        );
        const afterMove = await fixture.client.getMessages(chatId);
        expect(userContents(afterMove.messages)).toEqual([
          'relocation-turn-a',
          'relocation-turn-b',
        ]);
        expect(assistantContents(afterMove.messages)).toEqual([
          'echo:relocation-turn-a',
          'echo:relocation-turn-b',
        ]);

        await fixture.restartGarcon();
        expect(await readClaudeChat(fixture.dirs.workspace, chatId)).toMatchObject(relocated);
        const restored = await fixture.client.getMessages(chatId);
        expect(userContents(restored.messages)).toEqual(userContents(afterMove.messages));
        expect(assistantContents(restored.messages)).toEqual(assistantContents(afterMove.messages));

        const third = await runClaudeTurn(fixture, {
          chatId,
          content: 'relocation-turn-c',
          model: claude.defaultModel,
          settings: claude.defaultSettings,
        });
        expect((await fixture.client.waitForTurnTerminal(chatId, third.turnId)).type).toBe(
          'agent-run-finished',
        );
        const finalHistory = await fixture.client.getMessages(chatId);
        expect(userContents(finalHistory.messages)).toEqual([
          'relocation-turn-a',
          'relocation-turn-b',
          'relocation-turn-c',
        ]);
        expect(assistantContents(finalHistory.messages)).toEqual([
          'echo:relocation-turn-a',
          'echo:relocation-turn-b',
          'echo:relocation-turn-c',
        ]);
      },
      {
        serverEnvironment: environment,
        async prepareWorkspace(directories) {
          const fakeModule = fileURLToPath(
            new URL('../../support/fake-claude-cli.ts', import.meta.url),
          );
          const binaryPath = join(directories.root, 'claude');
          await writeFile(
            binaryPath,
            `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fakeModule).href)};\n`,
          );
          await chmod(binaryPath, 0o755);
          environment.CLAUDE_BINARY = binaryPath;
          environment.CLAUDE_CONFIG_DIR = join(directories.home, '.claude-integration');
          environment.ANTHROPIC_API_KEY = 'integration-fake-claude-key';
        },
      },
    );
  }, 30_000);
});

async function runClaudeTurn(
  fixture: IntegrationFixture,
  input: {
    chatId: string;
    content: string;
    model: string;
    settings: AgentSettingsEnvelope;
  },
) {
  return fixture.client.runChat({
    clientRequestId: randomUUID(),
    clientMessageId: randomUUID(),
    chatId: input.chatId,
    command: input.content,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettings: input.settings,
    model: input.model,
  });
}

async function readClaudeChat(workspace: string, chatId: string): Promise<PersistedClaudeChat> {
  const registry = JSON.parse(
    await readFile(join(workspace, 'chats.json'), 'utf8'),
  ) as { sessions: Record<string, PersistedClaudeChat> };
  const chat = registry.sessions[chatId];
  if (!chat) throw new Error(`Claude chat ${chatId} was not persisted`);
  return chat;
}

function queuePath(nativePath: string, sessionId: string): string {
  return join(dirname(nativePath), `${sessionId}.queue.json`);
}

function supportPath(nativePath: string, sessionId: string): string {
  return join(dirname(nativePath), sessionId);
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
