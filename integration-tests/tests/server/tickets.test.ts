import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpTicketMutationRequest, TicketMutationPayload } from '../../../common/ticket-commands.js';
import { parseTicketWriteResult } from '../../../common/ticket-records.js';
import { parseTicketBootstrap, parseTicketCommentsPage, parseTicketDetail, parseTicketPage,
  parseTicketProjectDefault } from '../../../common/ticket-responses.js';
import type { TicketsInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('persistent Tickets integration', () => {
  test('shares attributed mutations, invalidates after commit, and retries across restart and chat deletion', async () => {
    await withIntegrationFixture('tickets', async (fixture) => {
      const observer = await fixture.connectObserver('ticket-observer');
      const bootstrap = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      const workspaceFiles = await readdir(fixture.dirs.workspace);
      expect(workspaceFiles).toContain('tickets.sqlite');
      expect(workspaceFiles).not.toContain('issues.sqlite');
      const retiredRoute = await fetch(`${fixture.garcon.baseUrl}/api/v1/issues/bootstrap`);
      expect(retiredRoute.status).toBe(404);
      expect(await retiredRoute.text()).toBe('Not found');
      const request = (payload: TicketMutationPayload, fromChatId?: string): HttpTicketMutationRequest => ({
        expectedStoreId: bootstrap.storeId, requestId: crypto.randomUUID(), payload,
        ...(fromChatId ? { fromChatId } : {}),
      });
      const mutate = async (payload: TicketMutationPayload) =>
        parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', request(payload)));
      const cursor = observer.markEvents();
      const firstRequest = request({ action: 'create', input: { title: 'Synthetic ticket', project: 'Release group' } });
      const first = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', firstRequest));
      await observer.waitForEvent((event): event is TicketsInvalidatedMessage =>
        event.type === 'tickets-invalidated' && event.revision === first.collectionRevision,
      'committed ticket invalidation', { afterIndex: cursor });
      const committed = parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${first.ticket.id}`));
      expect(committed.ticket).toEqual(first.ticket);
      expect(committed.collectionRevision).toBe(first.collectionRevision);

      const second = await mutate({ action: 'create', input: { title: 'Dependent ticket', project: 'Release group' } });
      const linked = await mutate({ action: 'link', ticketId: first.ticket.id, expectedRevision: first.ticket.revision,
        targetId: second.ticket.id, targetRevision: second.ticket.revision, kind: 'blocks' });
      expect(linked.relatedTicket?.revision).toBe(2);
      const blocked = parseTicketPage(await fixture.client.get('/api/v1/tickets'));
      expect(blocked.items.find((entry) => entry.id === second.ticket.id)?.blockedByCount).toBe(1);

      const chatId = fixture.newChatId();
      const turn = await fixture.client.startDirectChat({ chatId, content: 'Synthetic source chat',
        projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi });
      await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
      const claimRequest = request({ action: 'claim', ticketId: first.ticket.id, expectedRevision: linked.ticket.revision }, chatId);
      const claimed = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', claimRequest));
      expect(claimed.ticket.assignee).toEqual({ kind: 'chat', chatId });
      expect(claimed.ticket.status).toBe('in-progress');
      await expect(fixture.client.post('/api/v1/tickets/mutate', request({
        action: 'claim', ticketId: first.ticket.id, expectedRevision: linked.ticket.revision,
      }))).rejects.toMatchObject({ status: 409, body: { errorCode: 'TICKET_REVISION_CONFLICT' } });
      const commentRequest = request({ action: 'comment', ticketId: first.ticket.id, body: 'Synthetic discussion' }, chatId);
      const comment = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', commentRequest));
      expect(comment.comment?.author).toMatchObject({ kind: 'user', declaredChatId: chatId });
      expect(comment.ticket.revision).toBe(claimed.ticket.revision);
      const closed = await mutate({ action: 'close', ticketId: first.ticket.id, expectedRevision: claimed.ticket.revision, resolution: 'done' });
      expect(closed.ticket.status).toBe('closed');
      expect(parseTicketPage(await fixture.client.get('/api/v1/tickets?ready=true')).items.map((entry) => entry.id))
        .toEqual([second.ticket.id]);
      await fixture.client.deleteChat(chatId);
      await fixture.restartGarcon();

      const restored = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      expect(restored.storeId).toBe(bootstrap.storeId);
      expect(restored.viewerKey).toBe(bootstrap.viewerKey);
      expect(parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', firstRequest))).toEqual(first);
      expect(parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', claimRequest))).toEqual(claimed);
      expect(parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', commentRequest))).toEqual(comment);
      const discussion = parseTicketCommentsPage(await fixture.client.get(`/api/v1/tickets/comments?ticketId=${first.ticket.id}`));
      expect(discussion.items).toHaveLength(1);
      expect(parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${first.ticket.id}`)).ticket)
        .toEqual(closed.ticket);
    });
  });

  test('fences requests captured before replacement of the ticket database', async () => {
    await withIntegrationFixture('ticket-store-replacement', async (fixture) => {
      const bootstrap = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      const create = (storeId: string): HttpTicketMutationRequest => ({ expectedStoreId: storeId,
        requestId: crypto.randomUUID(), payload: { action: 'create', input: { title: 'Synthetic ticket', project: 'Synthetic' } } });
      const first = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', create(bootstrap.storeId)));
      await fixture.restartGarcon({ beforeStart: async () => {
        await rename(join(fixture.dirs.workspace, 'tickets.sqlite'), join(fixture.dirs.workspace, 'tickets.backup.sqlite'));
      } });
      const replacement = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      expect(replacement.storeId).not.toBe(bootstrap.storeId);
      const second = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', create(replacement.storeId)));
      expect(second.ticket.id).toBe(first.ticket.id);
      const stale: HttpTicketMutationRequest = { requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
        payload: { action: 'update', ticketId: first.ticket.id, expectedRevision: 1, patch: { title: 'Wrong store' } } };
      await expect(fixture.client.post('/api/v1/tickets/mutate', stale))
        .rejects.toMatchObject({ status: 409, body: { errorCode: 'TICKET_STORE_CHANGED' } });
      expect(parseTicketPage(await fixture.client.get('/api/v1/tickets')).items[0]?.title).toBe('Synthetic ticket');
    });
  });

  test('resolves one default across a repository, linked worktree and nested directory', async () => {
    await withIntegrationFixture('ticket-project-default', async (fixture) => {
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
        const resolved = parseTicketProjectDefault(await fixture.client.post('/api/v1/tickets/project-default', { directory }));
        expect(resolved).toEqual({ project: fixture.dirs.project, kind: 'repository' });
      }
    });
  });
});
