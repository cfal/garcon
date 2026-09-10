import { describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import type { ReadTextResponse, SaveTextResponse } from '../../../common/file-contracts.js';
import type { GitRefsResponse } from '../../../common/git-refs.js';
import type { TerminalCreateResponse, TerminalListResponse } from '../../../common/terminal.js';
import { fixtureGit } from '../../support/fixture-git.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

async function nativeSource(fixture: IntegrationFixture, chatId: string): Promise<ChatDetailsResponse> {
  const details = await fixture.client.get<ChatDetailsResponse>(
    `/api/v1/chats/details?${new URLSearchParams({ chatId })}`,
  );
  expect(details.transcriptSource?.kind).toBe('filesystem-path');
  expect(details.transcriptSource?.value).toStartWith(join(fixture.dirs.workspace, 'agent-data'));
  expect((await stat(details.transcriptSource!.value)).isFile()).toBe(true);
  return details;
}

describe('standalone defaults', () => {
  test('keeps local execution, native storage, workspace services and CLI discovery on ordinary startup', async () => {
    await withIntegrationFixture('standalone-defaults', async (fixture) => {
      expect((await fetch(`${fixture.garcon.baseUrl}/api/v1/chats`)).status).toBe(401);
      const chatId = fixture.newChatId();
      const agent = fixture.directAgents.openAi;
      const catalog = await fixture.client.listAgentCatalog();
      expect(catalog.agents.some((entry) => entry.id === agent.agentId)).toBe(true);

      const first = await fixture.client.startDirectChat({
        chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic first input',
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const source = await nativeSource(fixture, chatId);
      const before = await fixture.client.getMessages(chatId);

      const query = new URLSearchParams({ chatId, path: 'sample.txt' });
      const file = await fixture.client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(file.content).toBe('synthetic initial file\n');
      const saved = await fixture.client.put<SaveTextResponse>(`/api/v1/files/text?${query}`, {
        content: 'synthetic edited file\n', expectedRevision: file.revision, conflictResolution: 'reject',
      });
      expect(saved.success).toBe(true);
      expect(await readFile(join(fixture.dirs.project, 'sample.txt'), 'utf8')).toBe('synthetic edited file\n');
      const refs = await fixture.client.get<GitRefsResponse>(
        `/api/v1/git/refs?${new URLSearchParams({ project: fixture.dirs.project })}`,
      );
      expect(refs.refs.some((ref) => ref.name === 'main')).toBe(true);

      const terminal = await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
        requestId: 'synthetic-terminal-create', requestedInitialWorkingDirectory: fixture.dirs.project,
      });
      expect(terminal.terminal).toMatchObject({
        initialWorkingDirectory: fixture.dirs.project, processStatus: 'running',
      });
      const terminals = await fixture.client.get<TerminalListResponse>('/api/v1/terminals');
      expect(terminals.terminals.map((entry) => entry.terminalId)).toContain(terminal.terminal.terminalId);

      const connection = await discoverRuntime({ configDir: fixture.dirs.config, workspace: 'standalone' });
      expect(connection.baseUrl).toStartWith('http://');
      expect(connection.tlsTrust).toBeUndefined();
      expect((await new GarconClient(connection).listChats()).sessions.map((chat) => chat.id)).toContain(chatId);

      await fixture.restartGarcon();

      expect((await fixture.client.get<TerminalListResponse>('/api/v1/terminals')).terminals).toEqual([]);
      expect(await nativeSource(fixture, chatId)).toMatchObject({
        agentSessionId: source.agentSessionId, transcriptSource: source.transcriptSource,
      });
      const restored = await fixture.client.getMessages(chatId);
      expect(restored.transcriptViewId).toBe(before.transcriptViewId);
      expect(restored.messages).toEqual(before.messages);

      const resumed = await fixture.client.runDirectChat({ chatId, agent, content: 'synthetic resumed input' });
      await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
      expect(await nativeSource(fixture, chatId)).toMatchObject({ agentSessionId: source.agentSessionId });
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content)).toEqual([
        'synthetic first input', 'echo:synthetic first input', 'synthetic resumed input',
      ]);
      expect((await fixture.client.get<ReadTextResponse>(`/api/v1/files/text?${query}`)).content)
        .toBe('synthetic edited file\n');
      const replacement = await discoverRuntime({ configDir: fixture.dirs.config, workspace: 'standalone' });
      expect(replacement.instanceId).not.toBe(connection.instanceId);
      expect(await new GarconClient(replacement).verifyRuntime()).toBe(true);
    }, {
      bindAddress: '0.0.0.0', namedWorkspace: 'standalone', authentication: 'account',
      async prepareWorkspace(directories) {
        await writeFile(join(directories.project, 'sample.txt'), 'synthetic initial file\n');
        await fixtureGit(directories.project, 'init', '-b', 'main');
        await fixtureGit(directories.project, 'add', 'sample.txt');
        await fixtureGit(directories.project, 'commit', '-m', 'Synthetic initial commit');
      },
    });
  }, 30_000);
});
