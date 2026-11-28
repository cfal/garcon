import { AgentCallError, type ExecutionFileTarget, type ExecutionFilesService } from '../../../../server-agents/interface/src/index.ts';
import { RemoteAgentIntegration } from '../../../../server/remote/client/remote-agent-integration.ts';
import type { RemoteSessionBacking, RemoteSessions } from '../../../../server/remote/client/executor-client.ts';
import { RemoteFilesService } from '../../../../server/remote/client/remote-files.ts';
import { ExecutorRpc } from '../../../../server/remote/transport/rpc.ts';
import type { ExecutorRpcRequest, IntegrationManifest } from '../../../../server/remote/transport/rpc-protocol.ts';
import { SessionTransport } from '../../../../server/remote/transport/session-transport.ts';

const executorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instanceId = 'worker';
const integrationId = 'fixture';
const target: ExecutionFileTarget = { projectPath: '/fixture', filePath: 'file.txt' };
const manifest: IntegrationManifest = {
  descriptor: {
    id: integrationId, label: 'Fixture', icon: null, supportedPermissionModes: [], supportedThinkingModes: [],
    supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
    supportedEndpointProtocols: [], configuration: [],
  },
  scope: { executorId, instanceId, integrationId },
  settings: { descriptors: [], defaults: { ownerId: integrationId, schemaVersion: 1, values: {} } },
  attachments: null,
  capabilities: {
    readiness: false, auth: false, commands: false, compaction: false, forking: false, steering: false,
    endpoints: false, singleQuery: false, legacyHistoryImport: false, nativeHistoryImport: true,
    nativeActivity: false, nativeSessions: false, configurationValidation: false, sessionConfiguration: false,
    projectPathUpdates: false, usageHistory: false, cliUpdates: false,
  },
  literalExecution: null,
  authMethods: { launchLogin: false, completeLogin: false, loginStatus: false },
  singleQueryRunsToolsWithoutPermission: false,
};

async function withWorker<T>(respond: (call: ExecutorRpcRequest) => unknown, use: (sessions: RemoteSessions) => Promise<T>): Promise<T> {
  const left = new SessionTransport('bulk', 'worker', () => {}, {}, executorId, 'bulk', 'parent');
  const right = new SessionTransport('bulk', 'controller', () => {}, {}, executorId, 'bulk', 'parent');
  const attachLeft = left.attach({ send: (body) => queueMicrotask(() => attachRight.receive(body)), close() {} });
  const attachRight = right.attach({ send: (body) => queueMicrotask(() => attachLeft.receive(body)), close() {} });
  const rpc = new ExecutorRpc(left);
  const worker = new ExecutorRpc(right);
  rpc.activate();
  worker.activate();
  worker.handle(async (call) => respond(call));
  const backing: RemoteSessionBacking = {
    rpc, info: { executorId, instanceId, projectBasePath: '/fixture', integrationIds: [integrationId],
      services: { files: true, git: true, gh: true, terminals: true, directoryCreation: true } },
    manifests: new Map([[integrationId, manifest]]),
  };
  const sessions: RemoteSessions = {
    latest: () => backing,
    acquire: async (lane, options) => {
      if (lane !== 'bulk') throw new Error('fixture only has bulk');
      return { backing, timeoutMs: options?.timeoutMs ?? 120_000 };
    },
    send: async (lane, options, send) => send(await sessions.acquire(lane, options)),
    call: (id, method, request, options) => rpc.call(id, method, request, options),
  };
  try { return await use(sessions); }
  finally { left.close(); right.close(); }
}

export async function readReply(value: unknown) {
  return withWorker(() => value, async (sessions) => {
    const { bytes, path, revision } = await new RemoteFilesService(sessions).read(target);
    return { bytes: [...bytes], path, revision };
  });
}

type Save = Parameters<ExecutionFilesService['save']>[0];

export function acceptsSave(value: unknown): value is Save {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<Save>;
  return typeof request.content === 'string' && typeof request.expectedRevision === 'string' &&
    typeof request.projectPath === 'string' && typeof request.filePath === 'string' &&
    (request.conflictResolution === 'reject' || request.conflictResolution === 'overwrite');
}

export async function saveWire(request: Save) {
  let captured: string | undefined;
  return withWorker((call) => {
    captured = JSON.stringify(call.request);
    return { success: true, path: '/fixture/file.txt', message: 'Saved', revision: 'v1:new' };
  }, async (sessions) => {
    // Match the controller route's normalized save spread before forwarding.
    const { content, expectedRevision, conflictResolution, projectPath, filePath } = request;
    await new RemoteFilesService(sessions).save({ content, expectedRevision, conflictResolution, projectPath, filePath });
    return captured;
  });
}

type FailureKind = 'save' | 'createDirectory';
type Outcome = 'unknown' | 'not-dispatched' | 'rejected';

export function acceptsFailureKind(value: unknown): value is FailureKind { return value === 'save' || value === 'createDirectory'; }
export function acceptsOutcome(value: unknown): value is Outcome { return value === 'unknown' || value === 'not-dispatched' || value === 'rejected'; }

export async function fileFailure(kind: FailureKind, outcome: Outcome) {
  return withWorker(() => { throw new AgentCallError(outcome, 'synthetic file failure'); }, async (sessions) => {
    const service = new RemoteFilesService(sessions);
    try {
      if (kind === 'save') return await service.save({ content: 'sample', expectedRevision: 'v1:old', conflictResolution: 'reject', ...target });
      return await service.createDirectory({ parentPath: '/fixture', name: 'child' });
    } catch (error) {
      if (error instanceof AgentCallError) return { outcome: error.outcome, code: error.code, message: error.message };
      throw error;
    }
  });
}

export async function historyRows(rows: unknown) {
  return withWorker((call) => {
    if (call.method === 'history.open') return { ...manifest.scope, kind: 'history-reader', id: 'reader' };
    if (call.method === 'history.next') return { done: false, rows };
    return undefined;
  }, async (sessions) => {
    const integration = new RemoteAgentIntegration(manifest, sessions);
    const history = integration.nativeHistoryImport;
    if (!history) throw new Error('Missing fixture history');
    const request = { chat: { chatId: '1783725900000000', projectPath: '/fixture', agentSessionId: 'session',
      nativeSession: null, model: 'fixture', agentId: integrationId, carryOverRevision: '0', nativeSeedReceipt: null,
      settings: manifest.settings.defaults }, signal: new AbortController().signal };
    for await (const batch of history.load(request)) return JSON.stringify(batch);
    throw new Error('Missing fixture history page');
  });
}
