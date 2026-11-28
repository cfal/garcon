import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentOwnershipJournal } from '../../../../server/controller/chats/agent-ownership-journal.ts';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const CHAT = '1783725900000200';
const EXECUTOR = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const SESSION = 'fixture-session';
const OPERATION = 'handoff:fixture';
const settings = (ownerId: string) => ({ ownerId, schemaVersion: 1, values: JSON.parse('{"b":1.0,"10":"ten","2":"two","big":9007199254740993,"exp21":1e21,"zero":-0}') });
const target = {
  executorId: EXECUTOR, projectPath: '/worker/project', agentId: 'claude', model: 'target-model',
  apiProviderId: 'fixture-provider', modelEndpointId: 'fixture-endpoint', modelProtocol: 'anthropic-messages',
  permissionMode: 'acceptEdits', thinkingMode: 'low', agentSettings: settings('claude'),
} as const;

const [mode, workspaceDir] = process.argv.slice(2);
if (!workspaceDir) throw new Error('Workspace required');
const journalPath = join(workspaceDir, 'agent-ownership-journal.json');
const file = () => readFile(journalPath, 'utf8');
const registry = new ChatRegistry(workspaceDir);
await registry.init();
if (mode === 'write-handoff' || mode === 'write-delete') {
  await writeFile(join(workspaceDir, 'workspace-version.json'), '{"version":10}\n');
  registry.addChat({ id: CHAT, agentId: 'codex', agentOwnershipEpoch: 'source-epoch', agentSettingsById: { codex: settings('codex') },
    model: 'source-model', projectPath: '/workspace/project', executorId: mode === 'write-delete' ? EXECUTOR : 'local',
    agentSessionId: SESSION, preambleSelection: { revision: 3, orderedPreambleIds: [] }, parentChatId: null, lineage: null });
  await registry.flush();
}
const deletes: string[] = [];
const journal = new AgentOwnershipJournal({ workspaceDir, registry,
  integrations: { get: () => null, require: () => { throw new Error('offline'); } },
  ledger: { deleteChat: (chatId) => { deletes.push(chatId); } }, isExecutorConfigured: () => true,
});
await journal.initialize();
if (mode === 'write-handoff' || mode === 'apply-handoff') {
  const intent = await journal.decideHandoff({ operationId: OPERATION, clientRequestId: 'fixture',
    submittedTargetHash: 'a'.repeat(64), chatId: CHAT, source: registry.getChat(CHAT)!, target,
    targetAgentOwnershipEpoch: 'target-epoch', watermark: { viewId: 'fixture-view', ordinal: 7 } });
  const decided = await file();
  if (mode === 'write-handoff') {
    console.log(JSON.stringify({ intent, decided }));
  } else {
    await journal.applyHandoffDecision(OPERATION);
    const applied = await file();
    const registryBytes = await readFile(join(workspaceDir, 'chats.json'), 'utf8');
    await journal.completeHandoff(OPERATION);
    console.log(JSON.stringify({ intent, decided, applied, registryBytes, completed: await file(), deletes }));
  }
} else if (mode === 'write-delete' || mode === 'recover-delete') {
  if (mode === 'write-delete') await journal.delete(CHAT);
  await journal.waitForProviderCleanup();
  console.log(JSON.stringify({ file: await file(), deletes, pending: journal.hasPending(CHAT),
    references: journal.referencesExecutor(EXECUTOR), blocks: journal.blocksExecutorRemoval(EXECUTOR) }));
} else {
  throw new Error('Unknown ownership oracle mode');
}
