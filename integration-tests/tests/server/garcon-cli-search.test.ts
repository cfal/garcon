import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatSearch } from '../../../common/chat-filter-query.js';
import { cliEnvironment } from '../../support/cli-environment.js';
import {
  type IntegrationFixture,
  cliConnectionArguments,
  withCliFixture,
} from '../../support/cli-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
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
      ...cliConnectionArguments(fixture),
      ...arguments_,
    ],
    cwd: REPO_ROOT,
    env: cliEnvironment({ HOME: fixture.dirs.home }),
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
  test('preserves identifier punctuation through HTTP paging and CLI forwarding', async () => {
    await withCliFixture('garcon-cli-search-literals', async (fixture) => {
      const unicodeLiterals = ['#K\u0130-123', '/workspace/Cafe\u0301x/file.ts'];
      const quotedFragments = ['"type":"tool_use"', '{"type":"tool_use"}', 'key:"value"'];
      const contents = [
        `marker ${'synthetic context '.repeat(100)}Review #731. useful trailing explanation`,
        'Review PR#731.',
        '731: synthetic source line',
        '00:00:00.731Z',
        'Review #7310.',
        ...unicodeLiterals.map((literal) => `${'='.repeat(600)}${literal} useful trailing explanation`),
        'foo PR #K\u0130-123',
        'foo\u0000bar',
        ...quotedFragments,
        'alphabet betamax',
        'alpha beta gamma delta epsilon zeta eta theta iota',
        '\u10d0\u10d1\u10d2\u10d3\u10d0',
        `PR${'\u0085'.repeat(600)}#K\u0130-123 useful trailing explanation`,
      ];
      const chatIds: string[] = [];
      for (const content of contents) {
        const chatId = fixture.newChatId();
        const turn = await fixture.client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.executionDirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
        chatIds.push(chatId);
      }
      await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 60_000 });
      for (const query of ['#731', '"#731"']) {
        const first = await fixture.client.searchChats({
          query, textTokens: ['#731'], chatIds, sort: 'created', offset: 0, limit: 1, snippetLimit: 1,
        });
        const last = await fixture.client.searchChats({
          query, textTokens: ['#731'], chatIds, sort: 'created', offset: 1, limit: 1, snippetLimit: 1,
        });
        expect(first.page).toEqual({ offset: 0, limit: 1, total: 2, hasMore: true, nextOffset: 1 });
        expect(last.page).toEqual({ offset: 1, limit: 1, total: 2, hasMore: false, nextOffset: null });
        const results = [...first.results, ...last.results];
        expect(new Set(results.map((hit) => hit.chatId))).toEqual(new Set(chatIds.slice(0, 2)));
        expect(results.every((hit) => hit.snippets[0]?.text.includes('#731'))).toBe(true);
      }
      const prefix = await fixture.client.searchChats({
        query: '#731', mode: 'prefix', offset: 0, limit: 2, snippetLimit: 1,
      });
      expect(prefix.page.total).toBe(2);
      const cli = await runCli(fixture, ['search', '#731', '--json']);
      expect(cli).toMatchObject({ exitCode: 0, stderr: '' });
      const result = JSON.parse(cli.stdout);
      expect(result).toMatchObject({
        page: { total: 2 },
        interpretedQuery: { clauses: [{ kind: 'literal', text: '#731' }] },
        index: { resultsTruncated: false },
      });
      expect(new Set(result.results.map((hit: { chatId: string }) => hit.chatId)))
        .toEqual(new Set(chatIds.slice(0, 2)));
      const parserCases = [
        ...unicodeLiterals.map((query, index) => ({ query, chatIndex: 5 + index, snippet: query })),
        ...[
          'PR\u00a0#K\u0130-123', '"PR #K\u0130-123', '#K\u0130-123"',
          '" #K\u0130-123 "', '"#K\u0130-123 "', 'foo \u00a0 #K\u0130-123',
          '"PR\u0085#K\u0130-123"',
        ].map((query) => ({ query, chatIndex: 7, snippet: '#K\u0130-123' })),
        ...quotedFragments.map((query, index) => ({ query, chatIndex: 9 + index, snippet: query })),
        ...['alpha\nbeta', 'alpha\u00a0beta', 'alpha\u0085beta'].map((query) => ({
          query, chatIndex: 12, snippet: 'alphabet',
        })),
        {
          query: 'alpha - beta - gamma - delta - epsilon - zeta - eta - theta - iota',
          chatIndex: 13, snippet: 'alpha',
        },
        {
          query: '"PR #K\u0130-123"', chatIndex: 15,
          snippet: 'PR #K\u0130-123 useful trailing explanation',
        },
      ];
      for (const { query, chatIndex, snippet } of parserCases) {
        const chatId = chatIds[chatIndex]!;
        const browser = await fixture.client.searchChats({
          query, textTokens: parseChatSearch(query).textTokens, chatIds: [chatId],
          offset: 0, limit: 20, snippetLimit: 1,
        });
        expect(browser.results.map((hit) => hit.chatId)).toEqual([chatId]);
        expect(browser.results[0]!.snippets[0]!.text).toContain(snippet);
        if (chatIndex === 5 || chatIndex === 6) {
          expect(browser.results[0]!.snippets[0]!.text).toContain('useful trailing explanation');
        }
        const cli = await runCli(fixture, ['search', query, '--filter', `id:${chatId}`, '--json']);
        expect(cli).toMatchObject({ exitCode: 0, stderr: '' });
        const result = JSON.parse(cli.stdout);
        expect(result.results.map((hit: { chatId: string }) => hit.chatId))
          .toEqual([chatId]);
        expect(result.results[0].snippets[0].text).toContain(snippet);
      }
      const mixed = await fixture.client.searchChats({
        query: 'marker #731', chatIds: [chatIds[0]!], snippetLimit: 1,
      });
      expect(mixed.results[0]!.snippets[0]!.text).toContain('#731. useful trailing explanation');
      const browserPrefixQuery = '\u1c90\u1c91\u1c92';
      const browserPrefix = await fixture.client.searchChats({
        query: browserPrefixQuery,
        textTokens: parseChatSearch(browserPrefixQuery).textTokens,
        chatIds: [chatIds[14]!],
      });
      expect(browserPrefix.results.map((hit) => hit.chatId)).toEqual([chatIds[14]!]);
      const nul = await fixture.client.searchChats({ query: 'foo\u0000bar', chatIds });
      expect(nul.results.map((hit) => hit.chatId)).toEqual([chatIds[8]!]);
      for (const query of ['#731\ud800', '#731\udc00']) {
        const malformedUnicode = await fixture.client.timedSearchChats({ query, chatIds });
        expect(malformedUnicode.status).toBe(200);
        expect(malformedUnicode.body.results).toEqual([]);
      }
      const lexicalBound = await fixture.client.timedSearchChats({
        query: '', textTokens: Array(8).fill('\u754c'.repeat(1_024)),
      });
      expect(lexicalBound.status).toBe(200);
      const literalOverflow = await fixture.client.timedSearchChats({
        query: '', textTokens: Array(8).fill('\u754c'.repeat(1_023) + '?'),
      });
      expect(literalOverflow.status).toBe(400);
      expect(literalOverflow.body).toMatchObject({ errorCode: 'VALIDATION_FAILED' });
      const subsequent = await fixture.client.searchChats({ query: '#731', chatIds });
      expect(subsequent.page.total).toBe(2);
      const overLimitQuery = JSON.stringify(Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`key${index}`, `value${index}`]),
      ));
      const invalid = await fixture.client.timedSearchChats({ query: overLimitQuery });
      expect(invalid.status).toBe(400);
      const invalidCli = await runCli(fixture, ['search', overLimitQuery, '--json']);
      expect(invalidCli.exitCode).toBe(2);
      expect(invalidCli.stderr).toContain('at most 16 terms');
    });
  }, 120_000);

  test('lists, searches, and reads a chat after its project directory disappears', async () => {
    await withCliFixture('garcon-cli-search-read', async (fixture) => {
      const projectPath = path.join(fixture.executionDirs.project, 'removed-project');
      await fs.mkdir(projectPath);
      const parentChatId = fixture.newChatId();
      const chatId = fixture.newChatId();
      const firstTerm = marker('firstclause');
      const secondTerm = marker('secondclause');
      const agent = fixture.directAgents.openAi;
      const parent = await fixture.client.startDirectChat({
        chatId: parentChatId,
        content: marker('parentclause'),
        projectPath: fixture.executionDirs.project,
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
    await withCliFixture('garcon-cli-search-disabled', async (fixture) => {
      const result = await runCli(fixture, ['search', 'needle', '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain([
        'garcon-cli',
        ...cliConnectionArguments(fixture).map((argument, index) => index % 2 ? `'${argument}'` : argument),
        'transcript-search',
        'enable',
      ].join(' '));
    }, { namedWorkspace: WORKSPACE });
  });
});
