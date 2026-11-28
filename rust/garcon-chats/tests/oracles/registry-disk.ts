import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatRegistry, type NewChatRegistryEntry } from '../../../../server/controller/chats/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const LOCAL = '1783725900000200';
const REMOTE = '1783725900000201';
const EXECUTOR = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const EPOCH = 'fixture-epoch';
const agentId = 'codex';
const opaque = JSON.parse('{"b":1.0,"10":"ten","2":"two","big":9007199254740993,"exp21":1e21,"zero":-0}');
const make = (id: string): NewChatRegistryEntry => ({
  id, agentId, agentOwnershipEpoch: EPOCH, model: 'fixture-model', projectPath: '/workspace/project',
  preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
  agentSettingsById: { codex: { ownerId: agentId, schemaVersion: 1, values: opaque } },
  agentSessionId: 'fixture-session',
});

const [mode, workspace] = process.argv.slice(2);
if (!workspace) throw new Error('Workspace required');
const file = join(workspace, 'chats.json');
const store = new ChatRegistry(workspace);
await store.init();
if (mode === 'write') {
  await writeFile(join(workspace, 'workspace-version.json'), '{"version":10}\n');
  store.addChat({ ...make(LOCAL), executorId: 'local' });
  store.addChat({ ...make(REMOTE), executorId: EXECUTOR, parentChatId: LOCAL,
    lineage: { sourceChatId: LOCAL, kind: 'fork', transcriptViewId: 'fixture-view', ordinal: 1 },
    nativeSession: { ownerId: agentId, schemaVersion: 1, value: opaque },
    apiProviderId: 'fixture-provider', modelEndpointId: 'fixture-endpoint', modelProtocol: 'openai-compatible',
    tags: ['fixture','review'], permissionMode: 'acceptEdits', thinkingMode: 'low',
    pendingPreambleBoundary: { kind: 'new-chat', ownershipEpoch: EPOCH },
    carryOverSegments: [{ id: '9df00801-0000-1000-9000-000000000009', agentId, model: 'source-model',
      capturedAt: '2026-01-01T00:00:00.000Z', storedMessageCount: 2, visibleMessageCount: 1, trailingHandoff: null }],
  });
  await store.updateChat(LOCAL, { lastReadAt: '2026-01-01T00:00:00.000Z' }, { flush: true });
} else if (mode === 'rewrite') {
  await store.updateChatPhased(REMOTE, { tags: ['fixture','next'] });
  await store.flush();
} else if (mode !== 'inspect') {
  throw new Error('Expected write, rewrite, or inspect');
}

console.log(JSON.stringify({
  ids: store.listChatIds(),
  hasLocal: store.hasChat(LOCAL),
  hasPrototype: store.hasChat('toString'),
  local: store.lookupNativeSession('fixture-session', agentId),
  remote: store.lookupNativeSession('fixture-session', agentId, EXECUTOR),
  entries: store.listAllChats(),
  file: await readFile(file, 'utf8'),
}));
