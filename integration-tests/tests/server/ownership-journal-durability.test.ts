import { describe, expect, test } from 'bun:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { GarconApiError, type ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { isRecord } from '../../../common/json.js';
import type { ChatListRefreshRequestedMessage } from '../../../common/ws-events.js';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';

describe('ownership journal durability through HTTP', () => {
  for (const phase of ['decision', 'completion'] as const) {
    test(`keeps the ${phase} fence after rename until a retry confirms directory durability`, async () => {
      await withIntegrationFixture(`journal-${phase}-durability`, async (fixture) => {
        const chatId = fixture.newChatId();
        const source = fixture.directAgents.openAi;
        const target = fixture.directAgents.anthropic;
        const started = await fixture.client.startDirectChat({
          chatId, agent: source, projectPath: fixture.dirs.project, content: 'synthetic source input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const before = await fixture.client.getMessages(chatId);
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        await writeFile(modePath, phase);
        try {
          await expect(fixture.client.handoffDirectChat({
            chatId, agent: target, content: 'synthetic rejected handoff input',
          })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          const current = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId);
          expect(current?.agentId).toBe(phase === 'decision' ? source.agentId : target.agentId);
          const placement = await persistedPlacement(fixture, chatId);
          const destination = join(fixture.dirs.project, 'relocation-destination');
          await mkdir(destination);
          await expect(fixture.client.updateProjectPath({ chatId, projectPath: destination }))
            .rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          expect(await persistedPlacement(fixture, chatId)).toEqual(placement);
          expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)?.projectPath)
            .toBe(current?.projectPath);
          const history = await fixture.client.getMessages(chatId);
          if (phase === 'decision') expect(history).toEqual(before);
          else expect(history.messages.filter((row) => row.message.type === 'agent-switch')).toHaveLength(1);
          expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);
          await expect(fixture.client.runDirectChat({
            chatId, agent: phase === 'decision' ? source : target, content: 'synthetic forbidden dispatch',
          })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          const attempts = (await readFile(join(fixture.dirs.root, 'journal-fault-attempts'), 'utf8')).trim().split('\n');
          expect(attempts.length).toBeGreaterThanOrEqual(3);
          expect(new Set(attempts).size).toBe(1);
        } finally {
          await writeFile(modePath, 'none');
        }

        const resumed = await runAfterRecovery(fixture, chatId, target);
        await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
        expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(1);
        const recovered = await fixture.client.getMessages(chatId);
        expect(recovered.transcriptViewId).toBe(before.transcriptViewId);
        expect(recovered.messages.filter((row) => row.message.type === 'agent-switch')).toHaveLength(1);
        expect(recovered.messages.some((row) => 'content' in row.message
          && row.message.content === 'synthetic rejected handoff input')).toBeFalse();
        expect(recovered.messages.some((row) => 'content' in row.message
          && row.message.content === 'synthetic forbidden dispatch')).toBeFalse();
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(recovered);
        expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)?.agentId).toBe(target.agentId);
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
        resolveServerEnvironment: (directories) => ({ GARCON_TEST_JOURNAL_FAULT_DIR: directories.root }),
      });
    }, 30_000);
  }

  test('revalidates relocation against the owner installed while filesystem validation waits', async () => {
    const entered = new Deferred<void>();
    const release = new Deferred<void>();
    const gateToken = crypto.randomUUID();
    const gate = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${gateToken}`)
          return new Response(null, { status: 401 });
        entered.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      },
    });
    try {
      for (const authorization of ['', 'Bearer unrelated']) {
        const response = await fetch(`http://127.0.0.1:${gate.port}`, {
          headers: { authorization }, signal: AbortSignal.timeout(1_000),
        });
        expect(response.status).toBe(401);
        expect(entered.settled).toBeFalse();
      }
      await withIntegrationFixture('journal-relocation-owner-race', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startDirectChat({
          chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project,
          content: 'synthetic source input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const source = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)!;
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        const destination = join(fixture.dirs.project, 'relocation-destination');
        await mkdir(destination);
        await writeFile(modePath, 'decision');
        await expect(fixture.client.runChat({
          chatId, command: 'synthetic rejected handoff input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          handoff: {
            expectedAgentOwnershipEpoch: source.agentOwnershipEpoch,
            target: {
              agentId: 'amp', model: 'medium', permissionMode: 'bypassPermissions', thinkingMode: 'none',
              agentSettings: { ownerId: 'amp', schemaVersion: 2, values: {} },
            },
          },
        })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
        const relocation = fixture.client.updateProjectPath({ chatId, projectPath: destination })
          .then(() => null, (error: unknown) => error);
        try {
          await withTimeout(entered.promise, 5_000, () => 'Relocation did not reach filesystem validation');
          await writeFile(modePath, 'none');
          await fixture.client.waitForEvent(
            (event): event is ChatListRefreshRequestedMessage => event.type === 'chat-list-refresh-requested'
              && event.reason === 'agent-handoff' && event.chatId === chatId,
            'handoff recovery completed during relocation validation',
          );
          expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)?.agentId).toBe('amp');
          const placement = await persistedPlacement(fixture, chatId);
          release.resolve();
          expect(await relocation).toMatchObject({ status: 422, body: { errorCode: 'PROJECT_PATH_UPDATE_UNSUPPORTED' } });
          expect(await persistedPlacement(fixture, chatId)).toEqual(placement);
          expect(placement.projectPath).toBe(source.projectPath);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          const history = await fixture.client.getMessages(chatId);
          expect(history.messages.filter((row) => row.message.type === 'agent-switch')).toHaveLength(1);
          expect(history.messages.some((row) => 'content' in row.message
            && row.message.content === 'synthetic rejected handoff input')).toBeFalse();
        } finally {
          release.resolve();
          await relocation;
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
        resolveServerEnvironment: (directories) => ({
          GARCON_TEST_JOURNAL_FAULT_DIR: directories.root,
          GARCON_TEST_RELOCATION_GATE: `http://127.0.0.1:${gate.port}`,
          GARCON_TEST_JOURNAL_GATE_TOKEN: gateToken,
        }),
      });
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  }, 30_000);

  test('retries an ambiguous prepared delete without restarting the controller', async () => {
    await withIntegrationFixture('journal-delete-durability', async (fixture) => {
      const chatId = fixture.newChatId();
      const agent = fixture.directAgents.openAi;
      const started = await fixture.client.startDirectChat({
        chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic delete input',
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      const history = await fixture.client.getMessages(chatId);
      const modePath = join(fixture.dirs.root, 'journal-fault-mode');
      await writeFile(modePath, 'prepared-delete');
      try {
        await expect(fixture.client.deleteChat(chatId)).rejects.toMatchObject({ status: 500 });
        await expect(fixture.client.deleteChat(chatId)).rejects.toMatchObject({ status: 500 });
        expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeTrue();
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        const attempts = (await readFile(join(fixture.dirs.root, 'journal-fault-attempts'), 'utf8')).trim().split('\n');
        expect(attempts).toHaveLength(2);
        expect(new Set(attempts).size).toBe(1);
      } finally {
        await writeFile(modePath, 'none');
      }

      expect(await fixture.client.deleteChat(chatId)).toMatchObject({ success: true });
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
      resolveServerEnvironment: (directories) => ({ GARCON_TEST_JOURNAL_FAULT_DIR: directories.root }),
    });
  }, 30_000);

  test('completes an admitted delete retry after detached native cleanup discharges the intent', async () => {
    const completionEntered = new Deferred<void>();
    const retryEntered = new Deferred<void>();
    const release = new Deferred<void>();
    const gateToken = crypto.randomUUID();
    const gate = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${gateToken}`)
          return new Response(null, { status: 401 });
        const stage = new URL(request.url).pathname;
        if (stage === '/completion') completionEntered.resolve();
        else if (stage === '/retry') retryEntered.resolve();
        else return new Response(null, { status: 404 });
        await release.promise;
        return new Response(null, { status: 204 });
      },
    });
    try {
      for (const stage of ['completion', 'retry']) {
        for (const authorization of ['', 'Bearer unrelated']) {
          const response = await fetch(`http://127.0.0.1:${gate.port}/${stage}`, {
            headers: { authorization }, signal: AbortSignal.timeout(1_000),
          });
          expect(response.status).toBe(401);
          expect(completionEntered.settled).toBeFalse();
          expect(retryEntered.settled).toBeFalse();
        }
      }
      await withIntegrationFixture('journal-delete-retry-race', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const oldInput = 'synthetic conversation before deletion';
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: oldInput,
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const original = await fixture.client.getMessages(chatId);
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        const ledgerDirectory = join(fixture.dirs.workspace, 'transcript-ledgers', chatId);
        await writeFile(modePath, 'delete-retry-race');
        let retry: Promise<unknown> | undefined;
        try {
          expect(await fixture.client.deleteChat(chatId)).toMatchObject({ success: true });
          await withTimeout(completionEntered.promise, 5_000, () => 'Native cleanup did not reach completion barrier');
          await expect(access(ledgerDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'agent-ownership-journal.json'), 'utf8')))
            .toMatchObject({ ownershipIntents: [{ kind: 'delete', chatId }] });
          retry = fixture.client.deleteChat(chatId).catch((error: unknown) => error);
          await withTimeout(retryEntered.promise, 5_000, () => 'Delete retry did not reach the retained intent');
          release.resolve();
          expect(await retry).toMatchObject({ success: true });
          expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'agent-ownership-journal.json'), 'utf8')))
            .toMatchObject({ ownershipIntents: [] });
        } finally {
          release.resolve();
          await retry;
          await writeFile(modePath, 'none');
        }
        const replacement = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic fresh conversation',
        });
        await fixture.client.waitForTurnTerminal(chatId, replacement.turnId);
        expect(parseAgentTurnReceipt(await fixture.client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${replacement.turnId}`,
        ))).toMatchObject({ state: 'completed' });
        const fresh = await fixture.client.getMessages(chatId);
        expect(fresh.transcriptViewId).not.toBe(original.transcriptViewId);
        expect(fresh.messages.some((row) => 'content' in row.message && row.message.content === oldInput)).toBeFalse();
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
        resolveServerEnvironment: (directories) => ({
          GARCON_TEST_JOURNAL_FAULT_DIR: directories.root,
          GARCON_TEST_DELETE_RETRY_GATE: `http://127.0.0.1:${gate.port}/`,
          GARCON_TEST_JOURNAL_GATE_TOKEN: gateToken,
        }),
      });
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  }, 30_000);

  for (const fault of ['native-release-delete', 'delete-completion-before-rename', 'completion']) {
    test(`retries detached ${fault} cleanup and reuses the chat ID without restarting`, async () => {
      await withIntegrationFixture(`journal-detached-${fault}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const oldInput = 'synthetic prior conversation';
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: oldInput,
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const original = await fixture.client.getMessages(chatId);
        const details = await fixture.client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${chatId}`);
        if (details.transcriptSource?.kind !== 'filesystem-path') throw new Error('Missing synthetic native path');
        const nativePath = details.transcriptSource.value;
        const nativeBefore = await readFile(nativePath, 'utf8');
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        const attemptsPath = join(fixture.dirs.root, 'journal-fault-attempts');
        const ledgerDirectory = join(fixture.dirs.workspace, 'transcript-ledgers', chatId);
        await writeFile(join(fixture.dirs.root, 'journal-fault-native-path'), nativePath);
        await writeFile(modePath, fault);
        try {
          expect(await fixture.client.deleteChat(chatId)).toMatchObject({ success: true });
          expect((await readFile(attemptsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
          await expect(access(ledgerDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
          if (fault === 'native-release-delete') expect(await readFile(nativePath, 'utf8')).toBe(nativeBefore);
          else await expect(access(nativePath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(fixture.client.startDirectChat({
            chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic blocked replacement',
          })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        } finally {
          await writeFile(modePath, 'none');
        }
        await deleteAfterCleanupSettlement(fixture, chatId);
        await expect(access(nativePath)).rejects.toMatchObject({ code: 'ENOENT' });
        const replacement = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic replacement conversation',
        });
        await fixture.client.waitForTurnTerminal(chatId, replacement.turnId);
        expect(parseAgentTurnReceipt(await fixture.client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${replacement.turnId}`,
        ))).toMatchObject({ state: 'completed' });
        const fresh = await fixture.client.getMessages(chatId);
        expect(fresh.transcriptViewId).not.toBe(original.transcriptViewId);
        expect(fresh.messages.some((row) => 'content' in row.message && row.message.content === oldInput)).toBeFalse();
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
        resolveServerEnvironment: (directories) => ({ GARCON_TEST_JOURNAL_FAULT_DIR: directories.root }),
      });
    }, 30_000);
  }

  for (const fault of ['registry-flush-delete', 'registry-removed-delete', 'ledger-delete']) {
    test(`rejects false delete success and ID reuse after ${fault}, then retries without restart`, async () => {
      await withIntegrationFixture(`journal-${fault}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const oldInput = 'synthetic old conversation that must not survive deletion';
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: oldInput,
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const original = await fixture.client.getMessages(chatId);
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        const ledgerDirectory = join(fixture.dirs.workspace, 'transcript-ledgers', chatId);
        await writeFile(join(fixture.dirs.root, 'journal-fault-chat'), chatId);
        await writeFile(modePath, fault);
        try {
          await expect(fixture.client.deleteChat(chatId)).rejects.toMatchObject({ status: 500 });
          expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
          await access(ledgerDirectory);
          await expect(fixture.client.startDirectChat({
            chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic forbidden replacement',
          })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          await expect(fixture.client.deleteChat(chatId)).rejects.toMatchObject({ status: 500 });
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        } finally {
          await writeFile(modePath, 'none');
        }

        await deleteAfterCleanupSettlement(fixture, chatId);
        await expect(access(ledgerDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
        const replacement = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic fresh conversation',
        });
        await fixture.client.waitForTurnTerminal(chatId, replacement.turnId);
        expect(parseAgentTurnReceipt(await fixture.client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${replacement.turnId}`,
        ))).toMatchObject({ state: 'completed' });
        const fresh = await fixture.client.getMessages(chatId);
        expect(fresh.transcriptViewId).not.toBe(original.transcriptViewId);
        expect(fresh.messages.some((row) => 'content' in row.message && row.message.content === oldInput)).toBeFalse();
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(fresh);
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/journal-durability-preload.ts', import.meta.url))],
        resolveServerEnvironment: (directories) => ({ GARCON_TEST_JOURNAL_FAULT_DIR: directories.root }),
      });
    }, 30_000);
  }
});

async function deleteAfterCleanupSettlement(fixture: IntegrationFixture, chatId: string): Promise<void> {
  const modePath = join(fixture.dirs.root, 'journal-fault-mode');
  await writeFile(modePath, 'await-cleanup-settlement');
  try {
    expect(await fixture.client.deleteChat(chatId)).toMatchObject({ success: true });
    expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'agent-ownership-journal.json'), 'utf8')))
      .toMatchObject({ ownershipIntents: [] });
  } finally {
    await writeFile(modePath, 'none');
  }
}

function persistedPlacement(fixture: IntegrationFixture, chatId: string) {
  return waitForPersistedChat({
    directories: fixture.dirs, chatId,
    select: (chat) => ({ projectPath: chat.projectPath, executionLocation: chat.executionLocation }),
    timeoutMessage: 'Chat placement was not persisted',
  });
}

async function runAfterRecovery(fixture: IntegrationFixture, chatId: string, agent: ConfiguredDirectTestAgent) {
  await waitForPersistedChat({
    directories: fixture.dirs, chatId,
    select: (chat) => chat.agentId === agent.agentId ? true : null,
    timeoutMessage: 'Handoff did not install its target after journal durability recovered',
  });
  const deadline = Date.now() + 5_000;
  const request = {
    chatId, agent, content: 'synthetic explicit recovered input',
    clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
  };
  for (;;) {
    try {
      return await fixture.client.runDirectChat(request);
    } catch (error) {
      if (!(error instanceof GarconApiError) || error.status !== 409 || !isRecord(error.body)
        || error.body.errorCode !== 'OWNERSHIP_TRANSFER_PENDING' || Date.now() >= deadline) throw error;
    }
    await Bun.sleep(20);
  }
}
