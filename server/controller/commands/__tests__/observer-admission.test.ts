import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatRegistry } from '../../chats/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { CommandLedger } from '../command-ledger.js';
import { ChatCommandService } from '../chat-command-service.js';
import type { ChatCommandServiceDeps } from '../command-support.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { ChatRowService } from '../../chats/chat-row-service.js';
import { ChatPreambleSelectionService } from '../../preambles/chat-selection-service.js';
import { AgentSessionSettingsService } from '../../agents/session-settings-service.js';
import { isDirectDelegatedChild } from '../../chats/agent-delegation.js';

const chatId = '1783725900000101';
const parent = '1783725900000100';
const nextId = '1783725900000102';
const signal = new AbortController().signal;
const input = { chatId, clientRequestId: 'request', clientMessageId: 'input', transcriptViewId: 'view' };
const fork = { ...input, sourceChatId: chatId, chatId: nextId, command: 'Synthetic input' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function unused(): never { throw new Error('Read-only admission reached a side effect'); }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'observer-admission-'));
  const chats = new ChatRegistry(directory);
  await chats.init();
  chats.addChat({ id: chatId, agentId: 'test', model: 'model', projectPath: '/synthetic',
    parentChatId: parent, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
    nativeObservation: { kind: 'native-child', sourceChatId: parent, sourceOwnershipEpoch: 'epoch',
      sourceAgentSessionId: 'root', child: { ownerId: 'test', schemaVersion: 1, key: 'child', value: {} },
      parentKey: null, reportedModel: null } });
  const transcripts = new TranscriptLedgerService(new TranscriptLedgerStore(join(directory, 'ledgers')));
  transcripts.initializeChat(chatId);
  const ledger = new CommandLedger();
  const accept = spyOn(ledger, 'accept');
  const chatMutationLock = new KeyedPromiseLock();
  const deps = {
    chats, ledger, transcripts, chatMutationLock, fileMentions: { resolve: unused },
    get queue() { return unused(); }, get settings() { return unused(); },
    get recentTitleIcons() { return unused(); }, get metadata() { return unused(); },
    get agents() { return unused(); }, get chatListProjector() { return unused(); },
    get ownership() { return unused(); }, get handoffs() { return unused(); },
    get transientFeeds() { return unused(); }, get preambles() { return unused(); },
    get chatTags() { return unused(); }, inspectProject: unused,
    createForkedChat: unused, readForkedNativeHistory: unused,
  } satisfies ChatCommandServiceDeps;
  cleanups.push(async () => { transcripts.close(); await chats.flush(); await rm(directory, { recursive: true, force: true }); });
  return { chats, transcripts, chatMutationLock, accept, commands: new ChatCommandService(deps) };
}

const mutations: Array<[string, (commands: ChatCommandService) => Promise<unknown>]> = [
  ['run', c => c.submitRun({ ...input, command: 'Synthetic input' })],
  ['steer', c => c.submitSteer({ ...input, content: 'Synthetic input' })],
  ['queue create', c => c.submitQueueEntryCreate({ ...input, content: 'Synthetic input' })],
  ['queue replace', c => c.submitQueueEntryReplace({ ...input, entryId: 'entry', expectedRevision: 1, content: 'Replacement' })],
  ['queue delete', c => c.submitQueueEntryDelete({ ...input, entryId: 'entry' })],
  ['queue move', c => c.submitQueueEntryMove({ ...input, entryId: 'entry', targetEntryId: 'target', placement: 'before', expectedReorderRevision: 0, expectedSourceRevision: 1, expectedTargetRevision: 1 })],
  ['queue steer', c => c.submitQueueEntrySteer({ ...input, entryId: 'entry', expectedRevision: 1, expectedReorderRevision: 0 })],
  ['queue pause', c => c.mutateQueue({ chatId, action: 'pause' })],
  ['queue clear', c => c.mutateQueue({ chatId, action: 'clear' })],
  ['queue resume', c => c.mutateQueue({ chatId, action: 'resume', pauseId: 'pause' })],
  ['scheduled input', c => c.submitScheduledExistingChat({ ...input, command: 'Synthetic input', busyBehavior: 'queue' })],
  ['stop', c => c.submitStop(input)],
  ['interrupt', c => c.submitInterruptAndSend(input)],
  ['compact', c => c.submitCompact(input)],
  ['fork', c => c.forkChat(fork)],
  ['fork and run', c => c.submitForkRun(fork)],
  ['continuation', c => c.submitSelfHandoffRun(fork)],
  ['handoff', c => c.submitAgentHandoff({ ...input, handoff: { expectedAgentOwnershipEpoch: 'epoch', target: { agentId: 'test', model: 'other' } } }, signal)],
  ['permission', c => c.submitPermissionDecision({ ...input, allow: true, alwaysAllow: false, permissionOccurrenceId: 'permission',
    control: { chatId, serverInstanceId: 'server', runId: 'run', permissionOccurrenceId: 'permission' } })],
  ['project path', c => c.updateProjectPath({ chatId, projectPath: '/other', expectedExecutorId: 'local', expectedProjectPath: '/synthetic', expectedAgentOwnershipEpoch: 'epoch' })],
];

test.each(mutations)('observer rejects %s before command acceptance or provider access', async (_name, mutate) => {
  const f = await fixture();
  const before = f.chats.getChat(chatId);
  await expect(mutate(f.commands)).rejects.toMatchObject({ code: 'CHAT_READ_ONLY' });
  expect(f.chats.getChat(chatId)).toEqual(before);
  expect(f.transcripts.currentRows(chatId)).toEqual([]);
  expect(f.accept).not.toHaveBeenCalled();
});

test('direct row and preamble owners reject observers before adoption', async () => {
  const f = await fixture();
  const ensure = mock(unused);
  const rows = new ChatRowService({ registry: f.chats, ledger: f.transcripts, adoption: { ensure },
    ownershipJournal: { hasPending: unused }, chatMutationLock: f.chatMutationLock, logger: { warn: unused } });
  await expect(rows.add({ ...input, presentation: { style: 'notice' }, format: 'plain', disclosure: 'expanded', content: 'Synthetic row' }, signal))
    .rejects.toMatchObject({ code: 'CHAT_READ_ONLY' });
  const preambles = new ChatPreambleSelectionService({ registry: f.chats, ledger: f.transcripts,
    adoption: { ensure }, preambles: { snapshot: unused }, ownershipJournal: { hasPending: unused },
    chatMutationLock: f.chatMutationLock, selectionAdmissionLock: new KeyedPromiseLock() });
  await expect(preambles.update({ ...input, expectedRevision: 0, orderedPreambleIds: [] }))
    .rejects.toMatchObject({ code: 'CHAT_READ_ONLY' });
  expect(ensure).not.toHaveBeenCalled();
  expect(f.transcripts.currentRows(chatId)).toEqual([]);
});

test('settings and delegated parentage cannot grant observer execution authority', async () => {
  const f = await fixture();
  const settings = new AgentSessionSettingsService({ registry: f.chats,
    chatMutationLock: f.chatMutationLock, selectionAdmissionLock: new KeyedPromiseLock(),
    get directory() { return unused(); }, get endpointResolver() { return unused(); },
    get execution() { return unused(); }, hasAdmittedProviderTurn: unused });
  await expect(settings.updateSessionSettings(chatId, { model: 'other' })).rejects.toMatchObject({ code: 'CHAT_READ_ONLY' });
  expect(isDirectDelegatedChild(parent, chatId, f.chats.getChat(chatId))).toBe(false);
});
