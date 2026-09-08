import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-search-integration';

function marker(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
}

async function runCli(
  fixture: IntegrationFixture,
  arguments_: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'cli/main.ts',
      '--config-dir', fixture.dirs.config,
      '--workspace', WORKSPACE,
      '--server', fixture.garcon.baseUrl,
      ...arguments_,
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
      HOME: fixture.dirs.home,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('garcon-cli chat research', () => {
  test('lists, searches, and reads a chat after its project directory disappears', async () => {
    await withIntegrationFixture('garcon-cli-search-read', async (fixture) => {
      const projectPath = path.join(fixture.dirs.project, 'removed-project');
      await fs.mkdir(projectPath);
      const parentChatId = fixture.newChatId();
      const chatId = fixture.newChatId();
      const firstTerm = marker('firstclause');
      const secondTerm = marker('secondclause');
      const agent = fixture.directAgents.openAi;
      const parent = await fixture.client.startDirectChat({
        chatId: parentChatId,
        content: marker('parentclause'),
        projectPath: fixture.dirs.project,
        agent,
      });
      expect((await fixture.client.waitForTurnTerminal(parentChatId, parent.turnId)).type)
        .toBe('agent-run-finished');
      const first = await fixture.client.startChat({
        ...fixture.client.directStartRequest({
          chatId,
          content: firstTerm,
          projectPath,
          agent,
        }),
        parentChatId,
      });
      expect(first.parentChat).toEqual({ chatId: parentChatId, relation: 'delegation' });
      expect(first.turnId).toBeString();
      expect(first.chatId).toBe(chatId);
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
        .toBe('agent-run-finished');
      const second = await fixture.client.runDirectChat({
        chatId,
        content: secondTerm,
        agent,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type)
        .toBe('agent-run-finished');
      await fs.rm(projectPath, { recursive: true, force: true });

      const enabled = await runCli(fixture, ['transcript-search', 'enable', '--json']);
      expect(enabled).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(enabled.stdout)).toMatchObject({ enabled: true });
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 60_000 });

      const searchStatus = await runCli(fixture, ['transcript-search', 'status', '--json']);
      expect(searchStatus).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(searchStatus.stdout)).toMatchObject({
        version: 1,
        phase: 'ready',
        chats: { total: 2, indexed: 2, pending: 0, failed: 0, unindexed: 0 },
        queryStats: { served: 0, timedOut: 0, rejectedBusy: 0 },
      });

      const rebuilt = await runCli(fixture, ['transcript-search', 'rebuild', '--json']);
      expect(rebuilt).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(rebuilt.stdout)).toMatchObject({
        success: true,
        status: { version: 1 },
      });
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 60_000 });

      const child = (await fixture.client.listChats()).sessions.find((entry) => entry.id === chatId);
      if (!child?.activity.createdAt || !child.activity.lastActivityAt) {
        throw new Error('Child chat is missing activity timestamps.');
      }
      const createdMs = Date.parse(child.activity.createdAt);
      const updatedMs = Date.parse(child.activity.lastActivityAt);
      const identityAndDates = [
        `id:${chatId}`,
        `parent:${parentChatId}`,
        `created-after:${new Date(createdMs - 1).toISOString()}`,
        `created-before:${new Date(createdMs + 1).toISOString()}`,
        `updated-after:${new Date(updatedMs - 1).toISOString()}`,
        `updated-before:${new Date(updatedMs + 1).toISOString()}`,
      ].join(' ');

      const lineageCatalog = await runCli(fixture, [
        'chats', '--filter', identityAndDates, '--json',
      ]);
      expect(lineageCatalog).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(lineageCatalog.stdout)).toMatchObject({
        page: { total: 1 },
        chats: [{ chatId, parentChatId, parentRelation: 'delegation' }],
      });

      const catalog = await runCli(fixture, [
        'chats', '--filter', `project:${projectPath}`, '--json',
      ]);
      expect(catalog).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(catalog.stdout)).toMatchObject({
        page: { total: 1, hasMore: false },
        chats: [{ chatId, projectPath }],
      });

      const unquoted = await runCli(fixture, [
        'search', `${firstTerm} ${secondTerm}`,
        '--filter', `project:${projectPath}`,
        '--json',
      ]);
      expect(unquoted.exitCode).toBe(0);
      expect(unquoted.stderr).toBe('');
      const searchResult = JSON.parse(unquoted.stdout);
      expect(searchResult).toMatchObject({
        candidateChatCount: 1,
        page: { total: 1, hasMore: false },
        index: {
          indexedChatCount: 1,
          pendingChatCount: 0,
          failedChatCount: 0,
          unindexedChatCount: 0,
          resultsTruncated: false,
          failedChats: [],
          failedChatsOmittedCount: 0,
        },
        removedStaleResultCount: 0,
        results: [{ chatId, chat: { projectPath } }],
      });
      expect(searchResult.results[0]?.transcriptViewId).toBeString();

      const lineageSearch = await runCli(fixture, [
        'search', firstTerm, '--filter', identityAndDates, '--json',
      ]);
      expect(lineageSearch).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(lineageSearch.stdout)).toMatchObject({
        candidateChatCount: 1,
        page: { total: 1 },
        results: [{ chatId }],
      });

      const quoted = await runCli(fixture, [
        'search', `"${firstTerm} ${secondTerm}"`,
        '--filter', `project:${projectPath}`,
        '--json',
      ]);
      expect(quoted.exitCode).toBe(0);
      expect(JSON.parse(quoted.stdout)).toMatchObject({ page: { total: 0 }, results: [] });
      expect(quoted.stderr).toContain('search complete: no matching indexed transcript content');

      const hit = searchResult.results[0];
      const snippet = hit.snippets[0];
      expect(snippet.timestamp).toBeString();
      const read = await runCli(fixture, [
        'read', chatId, String(snippet.ordinal),
        '-B', '1', '-A', '1',
        '--transcript-view-id', hit.transcriptViewId,
        '--json',
      ]);
      expect(read).toMatchObject({ exitCode: 0, stderr: '' });
      const readResult = JSON.parse(read.stdout);
      expect(readResult).toMatchObject({
        chatId,
        transcriptViewId: hit.transcriptViewId,
        anchorOrdinal: snippet.ordinal,
      });
      expect(readResult.messages.some(
        (entry: { ordinal: number }) => entry.ordinal === snippet.ordinal,
      )).toBe(true);

      const disabled = await runCli(fixture, ['transcript-search', 'disable', '--json']);
      expect(disabled).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(disabled.stdout)).toMatchObject({ enabled: false });
    }, { namedWorkspace: WORKSPACE });
  }, 120_000);

  test('names the feature setting when transcript search is disabled', async () => {
    await withIntegrationFixture('garcon-cli-search-disabled', async (fixture) => {
      const result = await runCli(fixture, ['search', 'needle', '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain([
        'garcon-cli',
        '--workspace', `'${WORKSPACE}'`,
        '--config-dir', `'${fixture.dirs.config}'`,
        '--server', `'${fixture.garcon.baseUrl}'`,
        'transcript-search',
        'enable',
      ].join(' '));
    }, { namedWorkspace: WORKSPACE });
  });
});
