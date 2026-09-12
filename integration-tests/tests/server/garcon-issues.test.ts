import { describe, expect, test } from 'bun:test';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { garconIssueResultContent, parseGarconIssueResult, type GarconIssueResult } from '../../../common/garcon-issue-result.js';
import { parseIssueWriteResult } from '../../../common/issue-records.js';
import { parseIssueBootstrap, parseIssueCommentsPage, parseIssueDetail, parseIssueHistoryPage,
  parseIssuePage, parseIssueProjectDefault } from '../../../common/issue-responses.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

function issueCommands(fixture: IntegrationFixture, chatId: string) {
  let sequence = 0;
  return async (markup: string): Promise<GarconIssueResult> => {
    const prompt = `Synthetic issue instruction ${++sequence}.`;
    const initial = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    const acknowledgment = fixture.fakeProviders.openAi.holdNext({});
    const input = { chatId, content: prompt, projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi };
    const turn = sequence === 1 ? await fixture.client.startDirectChat(input) : await fixture.client.runDirectChat(input);
    await initial.received;
    initial.releaseText(markup);
    await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
    const request = await acknowledgment.received;
    const result = parseGarconIssueResult(request.lastUserText);
    if (!result) throw new Error('Missing exact issue result envelope');
    expect(request.lastUserText).toBe(garconIssueResultContent(result));
    await fixture.fakeProviders.openAi.waitForRequest({ lastUserText: garconIssueResultContent(result) });
    const cursor = fixture.client.markEvents();
    acknowledgment.releaseText('Synthetic acknowledgment received.');
    expect((await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor })).type).toBe('agent-run-finished');
    return result;
  };
}

function mutation(result: GarconIssueResult) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok' || !('revision' in result.data)) throw new Error('Expected issue mutation receipt');
  return result.data;
}

describe('Garcon issue commands', () => {
  test('uses the captured chat project when Git metadata is broken, through commands and HTTP defaults', async () => {
    await withIntegrationFixture('garcon-issues-broken-git', async (fixture) => {
      const project = await realpath(fixture.dirs.project);
      await writeFile(join(fixture.dirs.project, '.git'), 'gitdir: synthetic-missing-metadata\n');
      const resolved = parseIssueProjectDefault(await fixture.client.post('/api/v1/issues/project-default', {
        directory: fixture.dirs.project,
      }));
      expect(resolved).toEqual({ project, kind: 'folder' });
      const emit = issueCommands(fixture, fixture.newChatId());
      const created = mutation(await emit('<garcon-issue-create ref="fallback">{"title":"Synthetic fallback issue"}</garcon-issue-create>'));
      const detail = parseIssueDetail(await fixture.client.get(`/api/v1/issues/detail?issueId=${created.issueId}`));
      expect(detail.issue.project).toBe(project);
    });
  });

  test('rejects defaults whose canonical context would be trimmed to a different path', async () => {
    await withIntegrationFixture('garcon-issues-lossy-path', async (fixture) => {
      const sibling = join(fixture.dirs.project, 'context');
      await mkdir(sibling);
      for (const [index, suffix] of [' ', '\u00a0'].entries()) {
        const directory = `${sibling}${suffix}`;
        const alias = join(fixture.dirs.project, `alias-${index}`);
        await mkdir(directory);
        await symlink(directory, alias);
        for (const path of [directory, alias]) {
          await expect(fixture.client.post('/api/v1/issues/project-default', { directory: path }))
            .rejects.toMatchObject({ status: 503, body: { errorCode: 'ISSUE_PROJECT_UNAVAILABLE' } });
        }
      }
    });
  });

  test('shares attributed state with HTTP and preserves exact retries through native reload and restart', async () => {
    await withIntegrationFixture('garcon-issues', async (fixture) => {
      const chatId = fixture.newChatId();
      const emit = issueCommands(fixture, chatId);
      const create = '<garcon-issue-create ref="create">{"title":"Synthetic task"}</garcon-issue-create>';
      const first = mutation(await emit(create));
      const detail = parseIssueDetail(await fixture.client.get(`/api/v1/issues/detail?issueId=${first.issueId}`));
      expect(detail.issue.project).toBe(fixture.dirs.project);
      expect(detail.issue.createdBy).toEqual({ kind: 'chat', chatId, provenance: 'observed' });
      const list = await emit('<garcon-issue-list />');
      if (list.command !== 'list' || list.status !== 'ok') throw new Error('Expected list response');
      expect(list.data.items.map((issue) => issue.id)).toEqual([first.issueId]);
      const claimed = mutation(await emit(`<garcon-issue-claim ref="claim" issue-id="${first.issueId}" expected-revision="1" />`));
      expect(claimed.status).toBe('in-progress');
      const comment = mutation(await emit(`<garcon-issue-comment ref="comment" issue-id="${first.issueId}">Synthetic progress.</garcon-issue-comment>`));
      const discussion = parseIssueCommentsPage(await fixture.client.get(`/api/v1/issues/comments?issueId=${first.issueId}`));
      expect(discussion.items[0]?.author).toEqual({ kind: 'chat', chatId, provenance: 'observed' });
      expect(discussion.items[0]?.canEdit).toBe(false);
      const bootstrap = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      await expect(fixture.client.post('/api/v1/issues/mutate', { expectedStoreId: bootstrap.storeId,
        requestId: crypto.randomUUID(), fromChatId: chatId, payload: { action: 'comment-delete', issueId: first.issueId,
          commentId: comment.comment!.id, expectedRevision: 1 } }))
        .rejects.toMatchObject({ status: 403, body: { errorCode: 'ISSUE_FORBIDDEN' } });
      mutation(await emit(`<garcon-issue-comment-edit ref="edit-comment" issue-id="${first.issueId}" comment-id="${comment.comment!.id}" expected-revision="1">Edited progress.</garcon-issue-comment-edit>`));
      mutation(await emit(`<garcon-issue-close ref="close" issue-id="${first.issueId}" expected-revision="${claimed.revision}" />`));
      await fixture.client.reloadChat(chatId);
      expect(parseIssuePage(await fixture.client.get('/api/v1/issues?includeClosed=true')).items).toHaveLength(1);
      const history = parseIssueHistoryPage(await fixture.client.get(`/api/v1/issues/history?issueId=${first.issueId}`));
      expect(history.items.filter((entry) => entry.action === 'created')).toHaveLength(1);
      const messages = await fixture.client.getMessages(chatId);
      expect(messagesOfType(messages.messages, 'user-message').some((message) => message.content.startsWith('<garcon-issue-'))).toBe(false);
      expect(messagesOfType(messages.messages, 'transcript-notice').some((message) => message.detail?.type === 'issue-command-outcome')).toBe(true);
      await fixture.restartGarcon();
      const retried = mutation(await emit(create));
      expect(retried).toEqual(first);
      expect(parseIssueDetail(await fixture.client.get(`/api/v1/issues/detail?issueId=${first.issueId}`)).issue.status).toBe('closed');
      expect(parseIssueHistoryPage(await fixture.client.get(`/api/v1/issues/history?issueId=${first.issueId}`)).items).toEqual(history.items);
    });
  }, 60_000);

  test('pages comments with exact revision fences and disables commands without disabling human management', async () => {
    await withIntegrationFixture('garcon-issues-pages', async (fixture) => {
      const chatId = fixture.newChatId();
      const emit = issueCommands(fixture, chatId);
      const first = mutation(await emit('<garcon-issue-create ref="create">{"title":"Synthetic issue","project":"Explicit group"}</garcon-issue-create>'));
      const bootstrap = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      for (let index = 0; index < 5; index++) {
        parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', { expectedStoreId: bootstrap.storeId,
          requestId: crypto.randomUUID(), payload: { action: 'comment', issueId: first.issueId, body: `Synthetic comment ${index}.` } }));
      }
      const sequences = [];
      let before: number | null = null;
      let revision: number | undefined;
      do {
        const query = { includeDescription: false, commentLimit: 2,
          ...(before ? { beforeCommentSequence: before, expectedCollectionRevision: revision } : {}) };
        const result = await emit(`<garcon-issue-read issue-id="${first.issueId}">${JSON.stringify(query)}</garcon-issue-read>`);
        if (result.command !== 'read' || result.status !== 'ok') throw new Error('Expected read page');
        sequences.push(...result.data.comments.items.map((comment) => comment.sequence));
        before = result.data.comments.nextBeforeSequence;
        revision = result.data.collectionRevision;
      } while (before !== null);
      expect(sequences).toEqual([4, 5, 2, 3, 1]);
      const closed = mutation(await emit(`<garcon-issue-close ref="close" issue-id="${first.issueId}" expected-revision="1" />`));
      expect(closed.status).toBe('closed');
      const stale = await emit(`<garcon-issue-read issue-id="${first.issueId}">{"commentLimit":2,"beforeCommentSequence":4,"expectedCollectionRevision":${revision}}</garcon-issue-read>`);
      expect(stale).toMatchObject({ status: 'error', errorCode: 'ISSUE_COLLECTION_CHANGED' });
      await fixture.client.updateSettings({ features: { agentCommands: { issues: false } } });
      expect(await emit('<garcon-issue-list />')).toMatchObject({ status: 'error', errorCode: 'ISSUE_COMMANDS_DISABLED' });
      const human = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', {
        expectedStoreId: bootstrap.storeId, requestId: crypto.randomUUID(),
        payload: { action: 'create', input: { title: 'Human issue', project: 'Explicit group' } },
      }));
      expect(human.issue.createdBy.kind).toBe('user');
    });
  }, 60_000);
});
