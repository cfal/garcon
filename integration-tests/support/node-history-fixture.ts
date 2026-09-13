import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentImportedTranscriptRow } from '../../server-agents/interface/src/index.js';
import { DirectSessionStore } from '../../server-agents/common/src/direct/session-store.js';
import { RemoteProviderHistoryImportService } from '../../server/execution-nodes/remote-provider-history-import.js';
import type { ProviderHistoryImportRequest } from '../../server/execution-nodes/provider-history-import.js';
import type { createNodeSessionFixture, ControllerFixtureConnection } from './node-session-handshake-fixture.js';

export type NodeHistoryFixture = Awaited<ReturnType<typeof createNodeSessionFixture>>;

export function historyRowContent({ message }: AgentImportedTranscriptRow): string {
  if (message.type !== 'user-message' && message.type !== 'assistant-message') throw new Error('Unexpected synthetic history message');
  return message.content;
}

export async function recoverHistoryConnection(controller: ControllerFixtureConnection): Promise<void> {
  const reply = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (reply.kind !== 'output-recovery') throw new Error('Synthetic recovery failed');
  await controller.client.service.call({ method: 'replay-output', generation: reply.generation, cursors: [] }, controller.signal);
  const resumed = await controller.client.service.call({ method: 'resume-output', generation: reply.generation }, controller.signal);
  if (resumed.kind !== 'output-live' || !resumed.live) throw new Error('Synthetic recovery did not reach live admission');
}

export async function remoteHistoryImporter(f: NodeHistoryFixture, controller: ControllerFixtureConnection, instanceId: string) {
  const binding = await controller.historyConnection();
  return new RemoteProviderHistoryImportService({ nodeId: f.pairing.nodeId, instanceId }, 'native',
    () => ({ nodeId: f.pairing.nodeId, workspaceId: 'synthetic-workspace' }), () => binding);
}

export async function createNodeHistoryRecord(f: NodeHistoryFixture, options: {
  instanceId?: string; agentId?: string; sessionId?: string; content?: string; response?: string;
} = {}) {
  const { instanceId = 'synthetic-instance', agentId = 'direct-anthropic-compatible',
    sessionId = '00000000-0000-4000-8000-000000000031', content = 'Synthetic native input', response = 'Synthetic response' } = options;
  const rootDirectory = path.join(f.storage, 'agent-data', 'instances', instanceId);
  const store = new DirectSessionStore({ host: { agentId, storage: { rootDirectory,
    async directory(namespace) { const directory = path.join(rootDirectory, namespace); await mkdir(directory, { recursive: true, mode: 0o700 }); return directory; },
    async claimLegacyWorkspaceDirectory() { return { moved: 0, skipped: 0 }; },
  } } });
  await store.create({ sessionId, runId: 'synthetic-run', content, attachments: [] });
  await store.appendAssistant({ sessionId, runId: 'synthetic-run', content: response });
  const request: ProviderHistoryImportRequest = { chat: { chatId: '1000000000000031', agentId, agentSessionId: sessionId,
    projectPath: '/synthetic/controller-label', model: '', nativeSession: store.nativeReference(sessionId), carryOverRevision: '', nativeSeedReceipt: null, settings: null } };
  return { request, instanceId, content };
}
