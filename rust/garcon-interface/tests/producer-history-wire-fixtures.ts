import { AssistantMessage, ReadToolUseMessage } from '../../../common/chat-types.ts';
import { createNativeSeedReceipt } from '../../../common/transcript-seed.ts';
import type {
  AgentEstablishedSession,
  AgentPermissionLifecycle,
  AgentProducerNotification,
} from '../../../server-agents/interface/src/contracts/producer.ts';
import type { AgentChatReference } from '../../../server-agents/interface/src/contracts/transcript.ts';
import type { ExecutorRpcMethods } from '../../../server/remote/transport/rpc-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const scope = { executorId: 'fixture-executor', instanceId: 'fixture-instance', integrationId: 'codex' };
const resource = <K extends string>(kind: K) => ({ ...scope, kind, id: `fixture-${kind}` });
const binding = resource('producer');
const response = resource('permission-response');
const timestamp = '2026-11-28T00:00:00Z';
const runId = 'fixture-run';
const permissionOccurrenceId = 'fixture-occurrence';
const agentSessionId = 'fixture-session';
const rawOpaque = '{"n":1.0,"10":10,"2":2,"big":9007199254740993,"exp21":1e21,"zero":-0}';
const opaque = JSON.parse(rawOpaque);
const nativeSession = { ownerId: 'codex', schemaVersion: 1, value: { session: 'fixture-native-session' } };
const nativeSeedReceipt = createNativeSeedReceipt({
  agentSessionId, placement: 'user-prefix', prefix: '<carried-context version="3">Synthetic context</carried-context>',
});
const session: AgentEstablishedSession = { agentSessionId, nativeSession, nativeSeedReceipt };
const settings = { ownerId: 'codex', schemaVersion: 1, values: {} };
const chat: AgentChatReference = {
  chatId: 'fixture-source', agentId: 'codex', agentSessionId, projectPath: '/work/source',
  model: 'fixture-model', nativeSession, carryOverRevision: 'fixture-revision', nativeSeedReceipt, settings,
};
const bind: ExecutorRpcMethods['producers.bind']['request'] = { binding, chatId: chat.chatId };
const requestedTool = new ReadToolUseMessage(timestamp, 'fixture-tool', '/work/source/example.txt', 0, 2);
const rows = [
  { message: new AssistantMessage(timestamp, 'Synthetic response') },
  { message: requestedTool, providerMeta: opaque },
];
const notifications: AgentProducerNotification[] = [
  { binding, event: { type: 'rows', rows } },
  { binding, event: { type: 'session', session } },
  { binding, event: { type: 'session', session: { agentSessionId, nativeSession: null, nativeSeedReceipt: null } } },
  { binding, event: {
    type: 'permission', runId,
    lifecycle: {
      kind: 'requested', permissionOccurrenceId, requestedTool,
      options: [{ provider: opaque, id: 'fixture-allow', label: 'Allow once' }], reason: 'Synthetic approval required',
    },
    decision: { permissionOccurrenceId, response },
  } },
  { binding, event: { type: 'permission', runId, lifecycle: { kind: 'cancelled', permissionOccurrenceId, reason: null } } },
  { binding, event: { type: 'permission', runId, lifecycle: { kind: 'expired', permissionOccurrenceId } } },
  { binding, event: { type: 'notice', runId, content: 'Synthetic retry', title: 'Retrying' } },
  { binding, event: {
    type: 'run-ended', runId, outcome: 'finished', finalResponse: { type: 'text', text: 'Synthetic response' },
  } },
  { binding, event: {
    type: 'run-ended', runId, outcome: 'finished', finalResponse: { type: 'literal-text', text: 'Synthetic output' },
    workingDirectory: { kind: 'reported', path: '/work/source' },
  } },
  { binding, event: { type: 'run-ended', runId, outcome: 'failed', error: { code: 'PROVIDER_FAILURE', message: 'Synthetic failure' } } },
  { binding, event: { type: 'run-ended', runId, outcome: 'interrupted', workingDirectory: { kind: 'withheld' } } },
  { binding, event: { type: 'started', runId } },
  { binding, event: { type: 'steerable', runId } },
  { binding, event: { type: 'publication-failed', error: { code: 'OUTCOME_UNKNOWN' } } },
  { binding, event: { type: 'publication-gap' } },
  { binding, event: { type: 'launch-settled', runId, handle: resource('execution') } },
  { binding, event: { type: 'launch-settled', runId, error: { code: 'OUTCOME_UNKNOWN' } } },
];
const decision: ExecutorRpcMethods['permissions.respond']['request'] = {
  response, decision: { allow: false, alwaysAllow: false, response: opaque },
};
const resolved: AgentPermissionLifecycle = { kind: 'resolved', permissionOccurrenceId, decision: decision.decision };
const open: ExecutorRpcMethods['history.open']['request'] = { source: 'nativeHistoryImport', request: { chat } };
const historyPage: ExecutorRpcMethods['history.next']['result'] = { done: false, rows };
const release: ExecutorRpcMethods['nativeSessions.release']['request'] = { chat, reason: 'transferred' };
const activity: ExecutorRpcMethods['nativeActivity.lastActivity']['result'][] = [
  { kind: 'ready', value: { lastEntryAt: timestamp } },
  { kind: 'ready', value: { lastEntryAt: null } },
  { kind: 'unavailable' },
];
const fork: ExecutorRpcMethods['forking.fork']['request'] = {
  chatId: 'fixture-fork', projectPath: chat.projectPath, model: chat.model, permissionMode: 'default',
  thinkingMode: 'none', settings, endpoint: null, source: chat, providerMeta: opaque,
};
const forkResults: ExecutorRpcMethods['forking.fork']['result'][] = [
  { kind: 'materialized', session }, { kind: 'unmaterialized' },
];
const discovery: ExecutorRpcMethods['apiProviders.discoverModels']['result'][] = [
  { success: true, models: [{ value: 'fixture-model', label: 'Fixture model' }] },
  { success: false, error: 'Synthetic discovery error' },
  { success: true, models: undefined },
];

const fixtures = {
  bind, close: binding, notifications, decision, resolved, historyRequest: open.request, historyPage,
  release, activity, nativeSession, fork, wholeFork: { ...fork, providerMeta: null }, forkResults,
  discard: session, discovery,
};
const wire = Object.fromEntries(Object.entries(fixtures).map(([name, value]) => [name, JSON.stringify(value)]));
console.log(JSON.stringify({ ...wire, rawDecision: JSON.stringify(decision).replace(JSON.stringify(opaque), rawOpaque) }));
