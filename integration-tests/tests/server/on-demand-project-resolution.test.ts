import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { TranscriptExportResponse } from '../../../common/chat-export-contracts.js';
import type { ProjectResolutionResponse } from '../../../common/project-resolution.js';
import type {
  AgentRunFinishedMessage,
  ChatExecutionControlUpdatedMessage,
  ChatOperationalNoticeMessage,
} from '../../../common/ws-events.js';
import { userContents } from '../../support/chat-assertions.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('on-demand project resolution', () => {
  test('keeps unavailable chats readable and rejects new work until the folder returns', async () => {
    await withIntegrationFixture('on-demand-project-resolution', async (fixture) => {
      await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
      const projectPath = join(fixture.dirs.project, 'movable-project');
      await mkdir(projectPath);
      const chatId = fixture.newChatId();
      const marker = 'synthetic unavailable project marker';
      const started = await fixture.client.startDirectChat({
        chatId,
        content: marker,
        projectPath,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const before = await fixture.client.getMessages(chatId);
      await fixture.client.waitForChatSearch(
        { query: 'synthetic unavailable', chatIds: [chatId] },
        (response) => response.results.some((result) => result.chatId === chatId),
      );
      await fixture.client.put('/api/v1/chats/last-selected', { chatId });
      const requestCount = fixture.fakeProviders.openAi.requests().length;

      await rm(projectPath, { recursive: true });

      const listed = await fixture.client.listChats();
      expect(listed.sessions.find((chat) => chat.id === chatId)).toMatchObject({ projectPath });
      expect(listed.lastSelectedChatId).toBe(chatId);
      const history = await fixture.client.getMessages(chatId);
      expect(history.transcriptViewId).toBe(before.transcriptViewId);
      expect(userContents(history.messages)).toEqual([marker]);
      const search = await fixture.client.searchChats({
        query: 'synthetic unavailable',
        chatIds: [chatId],
      });
      expect(search.results.map((result) => result.chatId)).toEqual([chatId]);
      const exported = await fixture.client.get<TranscriptExportResponse>(
        `/api/v1/chats/export?chatId=${chatId}`,
      );
      expect(exported.transcriptViewId).toBe(before.transcriptViewId);
      expect(exported.document).toContain(marker);
      expect(await resolveChatProject(fixture.client, chatId, projectPath)).toEqual({
        target: { kind: 'chat', chatId, projectPath },
        resolution: { kind: 'unavailable', reason: 'not-found' },
      });

      const retryRequest = fixture.client.directRunRequest({
        chatId,
        content: 'run after project restore',
        agent: fixture.directAgents.openAi,
        clientRequestId: 'request-project-restore',
        clientMessageId: 'message-project-restore',
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(fixture.client.runChat({
          ...retryRequest,
          transcriptViewId: before.transcriptViewId,
        })).rejects.toMatchObject({
          status: 409,
          body: { errorCode: 'PROJECT_UNAVAILABLE', retryable: false },
        });
      }
      await expect(fixture.client.enqueue({
        chatId,
        content: 'queue while unavailable',
        clientRequestId: 'request-queue-unavailable',
        clientMessageId: 'message-queue-unavailable',
        transcriptViewId: before.transcriptViewId,
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'PROJECT_UNAVAILABLE', retryable: false },
      });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      expect((await fixture.client.getMessages(chatId)).messages).toEqual(before.messages);

      await mkdir(projectPath);
      expect(await resolveChatProject(fixture.client, chatId, projectPath)).toMatchObject({
        resolution: { kind: 'available', effectiveProjectKey: projectPath },
      });
      const resumed = await fixture.client.runChat({
        ...retryRequest,
        transcriptViewId: before.transcriptViewId,
      });
      await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
      expect((await fixture.client.getMessages(chatId)).transcriptViewId).toBe(
        before.transcriptViewId,
      );
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount + 1);
    });
  }, 30_000);

  test('pauses before dequeue and clears pending work after a successful relocation', async () => {
    await withIntegrationFixture('on-demand-project-queue', async (fixture) => {
      const sourceProject = join(fixture.dirs.project, 'queue-source');
      const destinationProject = join(fixture.dirs.project, 'queue-destination');
      await mkdir(sourceProject);
      await mkdir(destinationProject);
      const chatId = fixture.newChatId();
      const heldSeed = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queue seed' });
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'queue seed',
        projectPath: sourceProject,
        agent: fixture.directAgents.openAi,
      });
      await heldSeed.received;
      await fixture.client.enqueueNew(chatId, 'preserved queued work');
      const initialPause = await fixture.client.pauseQueue(chatId);
      if (!initialPause.control.queue.pause) throw new Error('Queue did not enter a manual pause.');
      heldSeed.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      await rm(sourceProject, { recursive: true });

      const pauseCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, initialPause.control.queue.pause.id);
      const paused = await fixture.client.waitForEvent(
        (event): event is ChatExecutionControlUpdatedMessage => (
          event.type === 'chat-execution-control-updated'
          && event.chatId === chatId
          && event.control.queue.pause?.kind === 'manual'
        ),
        'project-unavailable queue pause',
        { afterIndex: pauseCursor },
      );
      expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual([
        'preserved queued work',
      ]);
      await fixture.client.waitForEvent(
        (event): event is ChatOperationalNoticeMessage => (
          event.type === 'chat-operational-notice'
          && event.chatId === chatId
          && event.noticeType === 'warning'
        ),
        'project-unavailable operational notice',
        { afterIndex: pauseCursor },
      );
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);

      const updated = await fixture.client.updateProjectPath({
        chatId,
        projectPath: destinationProject,
      });
      expect(updated).toMatchObject({
        projectPath: destinationProject,
        effectiveProjectKey: destinationProject,
        previousProjectPath: sourceProject,
      });
      expect((await fixture.client.getExecutionControl(chatId)).queue).toMatchObject({
        entries: [],
        pause: null,
      });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);

      const turnCursor = fixture.client.markEvents();
      const fresh = await fixture.client.runDirectChat({
        chatId,
        content: 'fresh work in destination',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForEvent(
        (event): event is AgentRunFinishedMessage => (
          event.type === 'agent-run-finished'
          && event.chatId === chatId
          && event.turnId === fresh.turnId
        ),
        'fresh relocated turn',
        { afterIndex: turnCursor },
      );
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.lastUserText).toBe(
        'fresh work in destination',
      );
    });
  }, 30_000);
});

async function resolveChatProject(
  client: GarconTestClient,
  chatId: string,
  projectPath: string,
): Promise<ProjectResolutionResponse> {
  const query = new URLSearchParams({ chatId, expectedProjectPath: projectPath });
  return client.get<ProjectResolutionResponse>(`/api/v1/projects/resolve?${query}`);
}
