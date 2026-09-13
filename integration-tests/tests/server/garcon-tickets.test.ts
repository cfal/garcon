import { describe, expect, test } from 'bun:test';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { garconTicketResultContent, parseGarconTicketResult, ticketCommandOutcome, type GarconTicketResult } from '../../../common/garcon-ticket-result.js';
import { ticketCommandNoticeText } from '../../../common/ticket-command-notice.js';
import { escapeGarconXmlText } from '../../../common/garcon-command-envelope.js';
import { parseTicketWriteResult } from '../../../common/ticket-records.js';
import { parseTicketBootstrap, parseTicketCommentsPage, parseTicketDetail, parseTicketHistoryPage,
  parseTicketPage, parseTicketProjectDefault } from '../../../common/ticket-responses.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

function ticketCommands(fixture: IntegrationFixture, chatId: string) {
  let sequence = 0;
  return async (markup: string): Promise<GarconTicketResult> => {
    const prompt = `Synthetic ticket instruction ${++sequence}.`;
    const initial = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    const acknowledgment = fixture.fakeProviders.openAi.holdNext({});
    const input = { chatId, content: prompt, projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi };
    const turn = sequence === 1 ? await fixture.client.startDirectChat(input) : await fixture.client.runDirectChat(input);
    await initial.received;
    initial.releaseText(markup);
    await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
    const request = await acknowledgment.received;
    const result = parseGarconTicketResult(request.lastUserText);
    if (!result) throw new Error('Missing exact ticket result envelope');
    expect(request.lastUserText).toBe(garconTicketResultContent(result));
    await fixture.fakeProviders.openAi.waitForRequest({ lastUserText: garconTicketResultContent(result) });
    const cursor = fixture.client.markEvents();
    acknowledgment.releaseText('Synthetic acknowledgment received.');
    expect((await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor })).type).toBe('agent-run-finished');
    const transcript = await fixture.client.getMessages(chatId);
    const notice = messagesOfType(transcript.messages, 'transcript-notice').find((message) =>
      message.detail?.type === 'ticket-command-outcome' && message.detail.requestViewId === result.requestViewId
      && message.detail.requestOrdinal === result.requestOrdinal);
    expect(notice?.detail).toEqual(ticketCommandOutcome(result));
    expect(notice?.content).toBe(ticketCommandNoticeText(ticketCommandOutcome(result)));
    expect(notice?.title).toBeUndefined();
    return result;
  };
}

function mutation(result: GarconTicketResult) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok' || !('revision' in result.data)) throw new Error('Expected ticket mutation receipt');
  return result.data;
}

describe('Garcon ticket commands', () => {
  test('retains descriptive relationship and filter notices through native reload', async () => {
    await withIntegrationFixture('garcon-ticket-notices', async (fixture) => {
      const chatId = fixture.newChatId();
      const emit = ticketCommands(fixture, chatId);
      const first = mutation(await emit('<garcon-ticket-create ref="first">{"title":"Synthetic first","project":"Release"}</garcon-ticket-create>'));
      const second = mutation(await emit('<garcon-ticket-create ref="second">{"title":"Synthetic second","project":"Release"}</garcon-ticket-create>'));
      const link = await emit(`<garcon-ticket-link ref="link" ticket-id="${first.ticketId}" expected-revision="1">{"targetId":"${second.ticketId}","targetRevision":1,"kind":"blocks"}</garcon-ticket-link>`);
      expect(ticketCommandNoticeText(ticketCommandOutcome(link))).toBe(`${first.ticketId} updated, added blocking link to ${second.ticketId}`);
      const receipt = mutation(link);
      const unlink = await emit(`<garcon-ticket-unlink ref="unlink" ticket-id="${first.ticketId}" expected-revision="${receipt.revision}">{"targetId":"${second.ticketId}","targetRevision":${receipt.relatedTicket!.revision},"kind":"blocks"}</garcon-ticket-unlink>`);
      expect(ticketCommandNoticeText(ticketCommandOutcome(unlink))).toBe(`${first.ticketId} updated, removed blocking link to ${second.ticketId}`);
      const filters = { project: 'Synthetic `<group> & [link](https://example.test)', priority: 1, label: 'ui' } as const;
      const list = await emit(`<garcon-ticket-list>${escapeGarconXmlText(JSON.stringify(filters))}</garcon-ticket-list>`);
      expect(list.status).toBe('ok');
      expect(list.context).toEqual({ filters });
      await emit('<garcon-ticket-list />');
      const before = messagesOfType((await fixture.client.getMessages(chatId)).messages, 'transcript-notice')
        .filter((message) => message.detail?.type === 'ticket-command-outcome');
      await fixture.client.reloadChat(chatId);
      const after = messagesOfType((await fixture.client.getMessages(chatId)).messages, 'transcript-notice')
        .filter((message) => message.detail?.type === 'ticket-command-outcome');
      expect(after.map(({ content, title, detail }) => ({ content, title, detail })))
        .toEqual(before.map(({ content, title, detail }) => ({ content, title, detail })));
      expect(after).toHaveLength(6);
    });
  }, 60_000);

  test('uses the captured chat project when Git metadata is broken, through commands and HTTP defaults', async () => {
    await withIntegrationFixture('garcon-tickets-broken-git', async (fixture) => {
      const project = await realpath(fixture.dirs.project);
      await writeFile(join(fixture.dirs.project, '.git'), 'gitdir: synthetic-missing-metadata\n');
      const resolved = parseTicketProjectDefault(await fixture.client.post('/api/v1/tickets/project-default', {
        directory: fixture.dirs.project,
      }));
      expect(resolved).toEqual({ project, kind: 'folder' });
      const emit = ticketCommands(fixture, fixture.newChatId());
      const created = mutation(await emit('<garcon-ticket-create ref="fallback">{"title":"Synthetic fallback ticket"}</garcon-ticket-create>'));
      const detail = parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${created.ticketId}`));
      expect(detail.ticket.project).toBe(project);
    });
  });

  test('rejects defaults whose canonical context would be trimmed to a different path', async () => {
    await withIntegrationFixture('garcon-tickets-lossy-path', async (fixture) => {
      const sibling = join(fixture.dirs.project, 'context');
      await mkdir(sibling);
      for (const [index, suffix] of [' ', '\u00a0'].entries()) {
        const directory = `${sibling}${suffix}`;
        const alias = join(fixture.dirs.project, `alias-${index}`);
        await mkdir(directory);
        await symlink(directory, alias);
        for (const path of [directory, alias]) {
          await expect(fixture.client.post('/api/v1/tickets/project-default', { directory: path }))
            .rejects.toMatchObject({ status: 503, body: { errorCode: 'TICKET_PROJECT_UNAVAILABLE' } });
        }
      }
    });
  });

  test('shares attributed state with HTTP and preserves exact retries through native reload and restart', async () => {
    await withIntegrationFixture('garcon-tickets', async (fixture) => {
      const chatId = fixture.newChatId();
      const emit = ticketCommands(fixture, chatId);
      const create = '<garcon-ticket-create ref="create">{"title":"Synthetic task"}</garcon-ticket-create>';
      const first = mutation(await emit(create));
      const detail = parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${first.ticketId}`));
      expect(detail.ticket.project).toBe(fixture.dirs.project);
      expect(detail.ticket.createdBy).toEqual({ kind: 'chat', chatId, provenance: 'observed' });
      const list = await emit('<garcon-ticket-list />');
      if (list.command !== 'list' || list.status !== 'ok') throw new Error('Expected list response');
      expect(list.data.items.map((ticket) => ticket.id)).toEqual([first.ticketId]);
      const claimed = mutation(await emit(`<garcon-ticket-claim ref="claim" ticket-id="${first.ticketId}" expected-revision="1" />`));
      expect(claimed.status).toBe('in-progress');
      const comment = mutation(await emit(`<garcon-ticket-comment ref="comment" ticket-id="${first.ticketId}">Synthetic progress.</garcon-ticket-comment>`));
      const discussion = parseTicketCommentsPage(await fixture.client.get(`/api/v1/tickets/comments?ticketId=${first.ticketId}`));
      expect(discussion.items[0]?.author).toEqual({ kind: 'chat', chatId, provenance: 'observed' });
      expect(discussion.items[0]?.canEdit).toBe(false);
      const bootstrap = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      await expect(fixture.client.post('/api/v1/tickets/mutate', { expectedStoreId: bootstrap.storeId,
        requestId: crypto.randomUUID(), fromChatId: chatId, payload: { action: 'comment-delete', ticketId: first.ticketId,
          commentId: comment.comment!.id, expectedRevision: 1 } }))
        .rejects.toMatchObject({ status: 403, body: { errorCode: 'TICKET_FORBIDDEN' } });
      mutation(await emit(`<garcon-ticket-comment-edit ref="edit-comment" ticket-id="${first.ticketId}" comment-id="${comment.comment!.id}" expected-revision="1">Edited progress.</garcon-ticket-comment-edit>`));
      mutation(await emit(`<garcon-ticket-close ref="close" ticket-id="${first.ticketId}" expected-revision="${claimed.revision}" />`));
      await fixture.client.reloadChat(chatId);
      expect(parseTicketPage(await fixture.client.get('/api/v1/tickets?includeClosed=true')).items).toHaveLength(1);
      const history = parseTicketHistoryPage(await fixture.client.get(`/api/v1/tickets/history?ticketId=${first.ticketId}`));
      expect(history.items.filter((entry) => entry.action === 'created')).toHaveLength(1);
      const messages = await fixture.client.getMessages(chatId);
      expect(messagesOfType(messages.messages, 'user-message').some((message) => message.content.startsWith('<garcon-ticket-'))).toBe(false);
      expect(messagesOfType(messages.messages, 'transcript-notice').some((message) => message.detail?.type === 'ticket-command-outcome')).toBe(true);
      await fixture.restartGarcon();
      const retried = mutation(await emit(create));
      expect(retried).toEqual(first);
      expect(parseTicketDetail(await fixture.client.get(`/api/v1/tickets/detail?ticketId=${first.ticketId}`)).ticket.status).toBe('closed');
      expect(parseTicketHistoryPage(await fixture.client.get(`/api/v1/tickets/history?ticketId=${first.ticketId}`)).items).toEqual(history.items);
    });
  }, 60_000);

  test('pages comments with exact revision fences and disables commands without disabling human management', async () => {
    await withIntegrationFixture('garcon-tickets-pages', async (fixture) => {
      const chatId = fixture.newChatId();
      const emit = ticketCommands(fixture, chatId);
      const first = mutation(await emit('<garcon-ticket-create ref="create">{"title":"Synthetic ticket","project":"Explicit group"}</garcon-ticket-create>'));
      const bootstrap = parseTicketBootstrap(await fixture.client.get('/api/v1/tickets/bootstrap'));
      for (let index = 0; index < 5; index++) {
        parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', { expectedStoreId: bootstrap.storeId,
          requestId: crypto.randomUUID(), payload: { action: 'comment', ticketId: first.ticketId, body: `Synthetic comment ${index}.` } }));
      }
      const sequences = [];
      let before: number | null = null;
      let revision: number | undefined;
      do {
        const query = { includeDescription: false, commentLimit: 2,
          ...(before ? { beforeCommentSequence: before, expectedCollectionRevision: revision } : {}) };
        const result = await emit(`<garcon-ticket-read ticket-id="${first.ticketId}">${JSON.stringify(query)}</garcon-ticket-read>`);
        if (result.command !== 'read' || result.status !== 'ok') throw new Error('Expected read page');
        sequences.push(...result.data.comments.items.map((comment) => comment.sequence));
        before = result.data.comments.nextBeforeSequence;
        revision = result.data.collectionRevision;
      } while (before !== null);
      expect(sequences).toEqual([4, 5, 2, 3, 1]);
      const closed = mutation(await emit(`<garcon-ticket-close ref="close" ticket-id="${first.ticketId}" expected-revision="1" />`));
      expect(closed.status).toBe('closed');
      const stale = await emit(`<garcon-ticket-read ticket-id="${first.ticketId}">{"commentLimit":2,"beforeCommentSequence":4,"expectedCollectionRevision":${revision}}</garcon-ticket-read>`);
      expect(stale).toMatchObject({ status: 'error', errorCode: 'TICKET_COLLECTION_CHANGED' });
      await fixture.client.updateSettings({ features: { agentCommands: { tickets: false } } });
      expect(await emit('<garcon-ticket-list />')).toMatchObject({ status: 'error', errorCode: 'TICKET_COMMANDS_DISABLED' });
      const human = parseTicketWriteResult(await fixture.client.post('/api/v1/tickets/mutate', {
        expectedStoreId: bootstrap.storeId, requestId: crypto.randomUUID(),
        payload: { action: 'create', input: { title: 'Human ticket', project: 'Explicit group' } },
      }));
      expect(human.ticket.createdBy.kind).toBe('user');
    });
  }, 60_000);
});
