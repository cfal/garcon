import { describe, expect, test } from 'bun:test';
import type {
  ChatPreambleSelectionTargetResponse,
  PreambleSelectionPreviewResponse,
  UpdateChatPreambleSelectionResponse,
} from '../../../common/chat-preamble-selection-contracts.js';
import type { PreambleDefinitionInput, PreamblesSnapshot } from '../../../common/preambles.js';
import type { ChatPreamblesInvalidatedMessage } from '../../../common/ws-events.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import type { ChatMessagesPage } from '../../support/garcon-client.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const MISSING_ID = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';

async function createPreamble(
  fixture: IntegrationFixture,
  revision: number,
  preamble: PreambleDefinitionInput,
): Promise<PreamblesSnapshot> {
  return (await fixture.client.post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
    expectedRevision: revision,
    preamble,
  })).snapshot;
}

function globalDefinition(title: string, content: string): PreambleDefinitionInput {
  return { enabled: true, title, content, scope: { type: 'global' } };
}

function selectionTarget(fixture: IntegrationFixture, chatId: string) {
  return fixture.client.get<ChatPreambleSelectionTargetResponse>(
    `/api/v1/chats/preambles?chatId=${chatId}`,
  );
}

function saveSelection(
  fixture: IntegrationFixture,
  request: Parameters<typeof fixture.client.put>[1] & Record<string, unknown>,
) {
  return fixture.client.put<UpdateChatPreambleSelectionResponse>('/api/v1/chats/preambles', request);
}

function updateNotices(page: ChatMessagesPage) {
  return messagesOfType(page.messages, 'transcript-notice').filter(
    (message) => message.detail?.type === 'preamble-selection-changed',
  );
}

function applicationNotices(page: ChatMessagesPage) {
  return messagesOfType(page.messages, 'transcript-notice').filter(
    (message) => message.detail?.type === 'preamble-application',
  );
}

describe('per-chat preambles', () => {
  test('[PREAMBLE-SELECTION.02-SERVER-01] saves a changed selection, notices it, and applies it in chat order on the next ordinary input', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      let catalog = await createPreamble(fixture, 0, globalDefinition('First', 'SYNTHETIC_FIRST_BODY'));
      catalog = await createPreamble(fixture, catalog.revision, globalDefinition('Second', 'SYNTHETIC_SECOND_BODY'));
      const [idFirst, idSecond] = catalog.preambles.map((preamble) => preamble.id);
      expect(typeof idFirst).toBe('string');
      expect(idFirst).not.toEqual(idSecond);

      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'initial prompt without preambles',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        orderedPreambleIds: [],
      });
      const firstRequest = await held.received;
      expect(firstRequest.lastUserText).not.toContain('<garcon-preambles');
      expect(held.releaseText('initial synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      const target = await selectionTarget(fixture, chatId);
      expect(target.selection).toEqual({ revision: 0, orderedPreambleIds: [] });

      const eventsCursor = fixture.client.markEvents();
      const saved = await saveSelection(fixture, {
        chatId,
        transcriptViewId: target.transcriptViewId,
        clientRequestId: 'selection-req-1',
        clientMessageId: 'selection-msg-1',
        expectedRevision: 0,
        orderedPreambleIds: [idSecond, idFirst],
      });
      expect(saved.status).toBe('updated');
      expect(saved.selection).toEqual({ revision: 1, orderedPreambleIds: [idSecond, idFirst] });
      expect(saved.projection.eligiblePreambles.map((entry) => entry.title))
        .toEqual(['Second', 'First']);

      // The update notice is committed before the per-chat invalidation fires.
      const invalidation = await fixture.client.waitForEvent(
        (event): event is ChatPreamblesInvalidatedMessage =>
          event.type === 'chat-preambles-invalidated' && event.chatId === chatId,
        'chat selection invalidation',
        { afterIndex: eventsCursor },
      );
      expect(invalidation.revision).toBe(1);

      const afterSave = await fixture.client.getMessages(chatId);
      expect(updateNotices(afterSave).map((entry) => entry.detail)).toEqual([{
        type: 'preamble-selection-changed',
        preambles: [
          { id: idSecond, title: 'Second' },
          { id: idFirst, title: 'First' },
        ],
      }]);

      const applyHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const applied = await fixture.client.runDirectChat({
        chatId,
        content: 'regular prompt after selection change',
        agent: fixture.directAgents.openAi,
      });
      const applyRequest = await applyHeld.received;
      // The prefix precedes the whole resend composition, so it must lead the
      // frame with the selected-order bodies.
      expect(applyRequest.lastUserText.startsWith(
        '<garcon-preambles version="1">\nSYNTHETIC_SECOND_BODY\n\nSYNTHETIC_FIRST_BODY\n</garcon-preambles>\n\n<!-- garcon-preamble-input --> ',
      )).toBeTrue();
      expect(applyRequest.lastUserText.indexOf('SYNTHETIC_SECOND_BODY'))
        .toBeLessThan(applyRequest.lastUserText.indexOf('SYNTHETIC_FIRST_BODY'));
      expect(applyHeld.releaseText('second synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, applied.turnId);

      const history = await fixture.client.getMessages(chatId);
      expect(applicationNotices(history).map((entry) => (
        entry.detail?.type === 'preamble-application'
          ? entry.detail.preambles.map((preamble) => preamble.title)
          : []
      ))).toEqual([['Second', 'First']]);
      expect(updateNotices(history)).toHaveLength(1);
      expect(JSON.stringify(history)).not.toContain('SYNTHETIC_FIRST_BODY');
      expect(JSON.stringify(history)).not.toContain('SYNTHETIC_SECOND_BODY');

      // A second ordinary turn applies nothing further.
      const laterHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const later = await fixture.client.runDirectChat({
        chatId,
        content: 'ordinary follow-up',
        agent: fixture.directAgents.openAi,
      });
      const laterRequest = await laterHeld.received;
      expect(laterRequest.lastUserText).not.toContain('<garcon-preambles');
      expect(laterHeld.releaseText('third synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, later.turnId);
      expect(applicationNotices(await fixture.client.getMessages(chatId))).toHaveLength(1);
    });
  });

  test('[PREAMBLE-SELECTION.02-SERVER-02] saving an empty selection notices None enabled and consumes the boundary without an application', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      const defaultsCatalog = await createPreamble(fixture, 0, globalDefinition('Global only', 'SYNTHETIC_GLOBAL_BODY'));

      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'start with defaults',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      expect(held.releaseText('defaults response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      const target = await selectionTarget(fixture, chatId);
      expect(target.selection.orderedPreambleIds).toEqual([defaultsCatalog.preambles[0]!.id]);

      const saved = await saveSelection(fixture, {
        chatId,
        transcriptViewId: target.transcriptViewId,
        clientRequestId: 'selection-empty-1',
        clientMessageId: 'selection-empty-msg-1',
        expectedRevision: 0,
        orderedPreambleIds: [],
      });
      expect(saved.status).toBe('updated');

      const afterSave = await fixture.client.getMessages(chatId);
      expect(updateNotices(afterSave).map((entry) => entry.detail)).toEqual([{
        type: 'preamble-selection-changed',
        preambles: [],
      }]);

      const held2 = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const followUp = await fixture.client.runDirectChat({
        chatId,
        content: 'prompt with none enabled',
        agent: fixture.directAgents.openAi,
      });
      const request = await held2.received;
      expect(request.lastUserText).not.toContain('<garcon-preambles');
      expect(held2.releaseText('none enabled response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, followUp.turnId);

      const history = await fixture.client.getMessages(chatId);
      expect(applicationNotices(history)).toHaveLength(1);
      const boundaryProofUser = userContents(history.messages).at(-1);
      expect(boundaryProofUser).toBe('prompt with none enabled');
    });
  });

  test('[PREAMBLE-SELECTION.02-SERVER-03] conflicts by revision, replays duplicates, and rejects unsafe compositions', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      await createPreamble(fixture, 0, globalDefinition('First', 'SYNTHETIC_FIRST_BODY'));

      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'initial',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        orderedPreambleIds: [],
      });
      await held.received;
      expect(held.releaseText('response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      const target = await selectionTarget(fixture, chatId);
      const request = {
        chatId,
        transcriptViewId: target.transcriptViewId,
        clientRequestId: 'selection-rev-1',
        clientMessageId: 'selection-rev-msg-1',
        expectedRevision: 4,
        orderedPreambleIds: [],
      };
      let conflict: unknown;
      try {
        await saveSelection(fixture, request);
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(GarconApiError);
      expect(conflict).toMatchObject({
        status: 409,
        body: { errorCode: 'PREAMBLE_SELECTION_REVISION_CONFLICT', retryable: true },
      });

      const conflictCatalog = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      const conflictFirstId = conflictCatalog.preambles[0]!.id;
      const saved = await saveSelection(fixture, {
        ...request,
        expectedRevision: 0,
        orderedPreambleIds: [conflictFirstId],
      });
      expect(saved.status).toBe('updated');

      const duplicate = await saveSelection(fixture, {
        ...request,
        expectedRevision: 0,
        orderedPreambleIds: [conflictFirstId],
      });
      expect(duplicate.status).toBe('duplicate');
      expect(duplicate.mutationRevision).toBe(1);
      const history = await fixture.client.getMessages(chatId);
      expect(updateNotices(history)).toHaveLength(1);

      let unsafe: unknown;
      try {
        await saveSelection(fixture, {
          chatId,
          transcriptViewId: target.transcriptViewId,
          clientRequestId: 'selection-unsafe-1',
          clientMessageId: 'selection-unsafe-msg-1',
          expectedRevision: 1,
          orderedPreambleIds: ['not-a-uuid'],
        });
      } catch (error) {
        unsafe = error;
      }
      expect(unsafe).toBeInstanceOf(GarconApiError);
      expect(unsafe).toMatchObject({
        status: 400,
      });
    });
  });

  test('[PREAMBLE-SELECTION.02-SERVER-04] forks copy the source selection and deleted IDs stay saved as missing', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      await createPreamble(fixture, 0, globalDefinition('First', 'SYNTHETIC_FIRST_BODY'));
      const forkCatalog = await createPreamble(fixture, 1, globalDefinition('Second', 'SYNTHETIC_SECOND_BODY'));
      const forkFirstId = forkCatalog.preambles[0]!.id;
      const forkSecondId = forkCatalog.preambles[1]!.id;

      const sourceChatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const started = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'source initial',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        orderedPreambleIds: [forkSecondId, forkFirstId],
      });
      await held.received;
      expect(held.releaseText('source response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, started.turnId);

      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      const forkTarget = await selectionTarget(fixture, forkChatId);
      expect(forkTarget.selection).toEqual({ revision: 0, orderedPreambleIds: [forkSecondId, forkFirstId] });

      // Deleting a selected catalog entry keeps the ID saved as missing.
      await fixture.client.delete('/api/v1/preambles', {
        expectedRevision: forkCatalog.revision,
        id: forkSecondId,
      });
      const afterDelete = await selectionTarget(fixture, forkChatId);
      expect(afterDelete.selection.orderedPreambleIds).toEqual([forkSecondId, forkFirstId]);
      expect(afterDelete.projection.unavailable).toContainEqual({
        id: forkSecondId,
        reason: 'missing',
      });
      expect(afterDelete.projection.eligiblePreambles.map((entry) => entry.title)).toEqual(['First']);

      const forkHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const forkTurn = await fixture.client.runDirectChat({
        chatId: forkChatId,
        content: 'fork first prompt',
        agent: fixture.directAgents.openAi,
      });
      const forkRequest = await forkHeld.received;
      expect(forkRequest.lastUserText).toContain('SYNTHETIC_FIRST_BODY');
      expect(forkRequest.lastUserText).not.toContain('SYNTHETIC_SECOND_BODY');
      expect(forkHeld.releaseText('fork response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(forkChatId, forkTurn.turnId);

      const history = await fixture.client.getMessages(forkChatId);
      expect(applicationNotices(history).at(-1)?.detail).toMatchObject({
        preambles: [{ id: forkFirstId, title: 'First' }],
      });

      // A newly created catalog entry can never acquire the retired identity.
      const currentCatalog = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      await createPreamble(fixture, currentCatalog.revision, globalDefinition('Resurrected', 'SYNTHETIC_RESURRECTED_BODY'));
      const snapshot = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      expect(snapshot.preambles.map((preamble) => preamble.id)).not.toContain(forkSecondId);
    });
  });

  test('[PREAMBLE-SELECTION.02-SERVER-05] previews resolve defaults and explicit drafts without side effects', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      const previewCatalog = await createPreamble(fixture, 0, globalDefinition('First', 'SYNTHETIC_FIRST_BODY'));
      await createPreamble(fixture, previewCatalog.revision, globalDefinition('Second', 'SYNTHETIC_SECOND_BODY'));
      const currentPreviewCatalog = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      const previewFirstId = currentPreviewCatalog.preambles[0]!.id;
      const previewSecondId = currentPreviewCatalog.preambles[1]!.id;

      const defaults = await fixture.client.post<PreambleSelectionPreviewResponse>(
        '/api/v1/preambles/selection-preview',
        { projectPath: fixture.dirs.project },
      );
      expect(defaults.orderedPreambleIds).toEqual([previewFirstId, previewSecondId]);
      expect(defaults.projection.eligiblePreambles).toHaveLength(2);
      expect(JSON.stringify(defaults)).not.toContain('SYNTHETIC_FIRST_BODY');

      const explicit = await fixture.client.post<PreambleSelectionPreviewResponse>(
        '/api/v1/preambles/selection-preview',
        { projectPath: fixture.dirs.project, orderedPreambleIds: [previewSecondId, MISSING_ID] },
      );
      expect(explicit.orderedPreambleIds).toEqual([previewSecondId, MISSING_ID]);
      expect(explicit.projection.eligiblePreambles.map((entry) => entry.title)).toEqual(['Second']);
      expect(explicit.projection.unavailable).toEqual([
        { id: MISSING_ID, reason: 'missing' },
      ]);

      const snapshotBefore = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      await fixture.client.post<PreambleSelectionPreviewResponse>(
        '/api/v1/preambles/selection-preview',
        { projectPath: fixture.dirs.project },
      );
      expect(await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles')).toEqual(snapshotBefore);
    });
  });
});
