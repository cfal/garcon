import { describe, expect, test } from 'bun:test';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpIssueMutationRequest, IssueMutationPayload } from '../../../common/issue-commands.js';
import { parseIssueWriteResult } from '../../../common/issue-records.js';
import { parseIssueBootstrap, parseIssueCommentsPage, parseIssueDetail, parseIssuePage,
  parseIssueProjectDefault } from '../../../common/issue-responses.js';
import type { IssuesInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('persistent Issues integration', () => {
  test('shares attributed mutations, invalidates after commit, and retries across restart and chat deletion', async () => {
    await withIntegrationFixture('issues', async (fixture) => {
      const observer = await fixture.connectObserver('issue-observer');
      const bootstrap = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      const request = (payload: IssueMutationPayload, fromChatId?: string): HttpIssueMutationRequest => ({
        expectedStoreId: bootstrap.storeId, requestId: crypto.randomUUID(), payload,
        ...(fromChatId ? { fromChatId } : {}),
      });
      const mutate = async (payload: IssueMutationPayload) =>
        parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', request(payload)));
      const cursor = observer.markEvents();
      const firstRequest = request({ action: 'create', input: { title: 'Synthetic issue', project: 'Release group' } });
      const first = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', firstRequest));
      await observer.waitForEvent((event): event is IssuesInvalidatedMessage =>
        event.type === 'issues-invalidated' && event.revision === first.collectionRevision,
      'committed issue invalidation', { afterIndex: cursor });
      const committed = parseIssueDetail(await fixture.client.get(`/api/v1/issues/detail?issueId=${first.issue.id}`));
      expect(committed.issue).toEqual(first.issue);
      expect(committed.collectionRevision).toBe(first.collectionRevision);

      const second = await mutate({ action: 'create', input: { title: 'Dependent issue', project: 'Release group' } });
      const linked = await mutate({ action: 'link', issueId: first.issue.id, expectedRevision: first.issue.revision,
        targetId: second.issue.id, targetRevision: second.issue.revision, kind: 'blocks' });
      expect(linked.relatedIssue?.revision).toBe(2);
      const blocked = parseIssuePage(await fixture.client.get('/api/v1/issues'));
      expect(blocked.items.find((entry) => entry.id === second.issue.id)?.blockedByCount).toBe(1);

      const chatId = fixture.newChatId();
      const turn = await fixture.client.startDirectChat({ chatId, content: 'Synthetic source chat',
        projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi });
      await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
      const claimRequest = request({ action: 'claim', issueId: first.issue.id, expectedRevision: linked.issue.revision }, chatId);
      const claimed = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', claimRequest));
      expect(claimed.issue.assignee).toEqual({ kind: 'chat', chatId });
      expect(claimed.issue.status).toBe('in-progress');
      await expect(fixture.client.post('/api/v1/issues/mutate', request({
        action: 'claim', issueId: first.issue.id, expectedRevision: linked.issue.revision,
      }))).rejects.toMatchObject({ status: 409, body: { errorCode: 'ISSUE_REVISION_CONFLICT' } });
      const commentRequest = request({ action: 'comment', issueId: first.issue.id, body: 'Synthetic discussion' }, chatId);
      const comment = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', commentRequest));
      expect(comment.comment?.author).toMatchObject({ kind: 'user', declaredChatId: chatId });
      expect(comment.issue.revision).toBe(claimed.issue.revision);
      const closed = await mutate({ action: 'close', issueId: first.issue.id, expectedRevision: claimed.issue.revision, resolution: 'done' });
      expect(closed.issue.status).toBe('closed');
      expect(parseIssuePage(await fixture.client.get('/api/v1/issues?ready=true')).items.map((entry) => entry.id))
        .toEqual([second.issue.id]);
      await fixture.client.deleteChat(chatId);
      await fixture.restartGarcon();

      const restored = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      expect(restored.storeId).toBe(bootstrap.storeId);
      expect(restored.viewerKey).toBe(bootstrap.viewerKey);
      expect(parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', firstRequest))).toEqual(first);
      expect(parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', claimRequest))).toEqual(claimed);
      expect(parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', commentRequest))).toEqual(comment);
      const discussion = parseIssueCommentsPage(await fixture.client.get(`/api/v1/issues/comments?issueId=${first.issue.id}`));
      expect(discussion.items).toHaveLength(1);
      expect(parseIssueDetail(await fixture.client.get(`/api/v1/issues/detail?issueId=${first.issue.id}`)).issue)
        .toEqual(closed.issue);
    });
  });

  test('fences requests captured before replacement of the issue database', async () => {
    await withIntegrationFixture('issue-store-replacement', async (fixture) => {
      const bootstrap = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      const create = (storeId: string): HttpIssueMutationRequest => ({ expectedStoreId: storeId,
        requestId: crypto.randomUUID(), payload: { action: 'create', input: { title: 'Synthetic issue', project: 'Synthetic' } } });
      const first = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', create(bootstrap.storeId)));
      await fixture.restartGarcon({ beforeStart: async () => {
        await rename(join(fixture.dirs.workspace, 'issues.sqlite'), join(fixture.dirs.workspace, 'issues.backup.sqlite'));
      } });
      const replacement = parseIssueBootstrap(await fixture.client.get('/api/v1/issues/bootstrap'));
      expect(replacement.storeId).not.toBe(bootstrap.storeId);
      const second = parseIssueWriteResult(await fixture.client.post('/api/v1/issues/mutate', create(replacement.storeId)));
      expect(second.issue.id).toBe(first.issue.id);
      const stale: HttpIssueMutationRequest = { requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
        payload: { action: 'update', issueId: first.issue.id, expectedRevision: 1, patch: { title: 'Wrong store' } } };
      await expect(fixture.client.post('/api/v1/issues/mutate', stale))
        .rejects.toMatchObject({ status: 409, body: { errorCode: 'ISSUE_STORE_CHANGED' } });
      expect(parseIssuePage(await fixture.client.get('/api/v1/issues')).items[0]?.title).toBe('Synthetic issue');
    });
  });

  test('resolves one default across a repository, linked worktree and nested directory', async () => {
    await withIntegrationFixture('issue-project-default', async (fixture) => {
      const git = async (...args: string[]) => {
        const child = Bun.spawn(['git', ...args], { cwd: fixture.dirs.project, stdout: 'pipe', stderr: 'pipe' });
        const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(`Synthetic Git setup failed: ${stderr}`);
      };
      await git('init');
      await git('-c', 'user.name=Synthetic Author', '-c', 'user.email=author@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic initial commit');
      const worktree = join(fixture.dirs.project, '.worktrees', 'linked');
      await git('worktree', 'add', '-b', 'synthetic-linked', worktree);
      const nested = join(worktree, 'nested');
      await mkdir(nested);
      for (const directory of [fixture.dirs.project, worktree, nested]) {
        const resolved = parseIssueProjectDefault(await fixture.client.post('/api/v1/issues/project-default', { directory }));
        expect(resolved).toEqual({ project: fixture.dirs.project, kind: 'repository' });
      }
    });
  });
});
