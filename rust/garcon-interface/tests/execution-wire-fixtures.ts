import { createNativeSeedReceipt } from '../../../common/transcript-seed.ts';
import type { AgentNativeSessionRef, AgentChatReference } from '../../../server-agents/interface/src/contracts/transcript.ts';
import type { ExecutorRpcMethods, IntegrationManifest } from '../../../server/remote/transport/rpc-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`expected Bun 1.4.3, got ${Bun.version}`);

const scope = { executorId: 'fixture-executor', instanceId: 'fixture-instance', integrationId: 'codex' };
const resource = <K extends string>(kind: K) => ({ ...scope, kind, id: `fixture-${kind}` });
const settings = { ownerId: 'codex', schemaVersion: 1, values: {} };
const nativeSession: AgentNativeSessionRef = {
  ownerId: 'codex', schemaVersion: 1,
  value: JSON.parse('{"10":10,"2":2,"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}'),
};
const prefix = '<carried-context version="3">Synthetic fixture</carried-context>';
const nativeSeedReceipt = createNativeSeedReceipt({ agentSessionId: 'fixture-session', placement: 'user-prefix', prefix });
const chat: AgentChatReference = {
  chatId: 'fixture-chat', agentId: 'codex', agentSessionId: 'fixture-session', projectPath: '/work/repo',
  model: 'fixture-model', nativeSession, carryOverRevision: 'fixture-revision', nativeSeedReceipt, settings,
};
const configuration: ExecutorRpcMethods['configurationValidation.validate']['request'] = {
  model: 'fixture-model', permissionMode: 'default', thinkingMode: 'none', settings, endpoint: null,
};
const context = {
  chatId: chat.chatId, projectPath: chat.projectPath,
  ...configuration,
  runId: 'fixture-run', producerBinding: resource('producer'),
};
const start: ExecutorRpcMethods['execution.start']['request'] = {
  ...context,
  submission: { clientMessageId: null, timestamp: '2026-11-20T00:00:00Z', presentation: { origin: 'cli', disclosure: 'collapsed' } },
  prompt: 'Synthetic input', attachments: [{ kind: 'image', data: 'Zml4dHVyZQ==', name: null, mimeType: 'image/png' }],
  carriedContext: { prefix, summaryTruncated: true },
};
const resume: ExecutorRpcMethods['execution.resume']['request'] = {
  ...context, agentSessionId: 'fixture-session', nativeSession, prompt: 'Synthetic follow-up', attachments: [],
};
const handle: ExecutorRpcMethods['execution.start']['result'] = resource('execution');
const sessions: ExecutorRpcMethods['execution.runningSessions']['result'] = [
  { agentSessionId: 'fixture-session', status: null, startedAt: null },
  { agentSessionId: 'fixture-other-session', status: 'busy', startedAt: '2026-11-20T00:00:00Z' },
];
const apply: ExecutorRpcMethods['sessionConfiguration.apply']['request'] = {
  args: ['fixture-session', { ...configuration, permissionModeExplicit: true }, configuration],
};
const prepare: ExecutorRpcMethods['projectPathUpdates.prepare']['request'] = { chat, nextProjectPath: '/work/other' };
const preparation = resource('project-path-preparation');
const prepared: readonly ExecutorRpcMethods['projectPathUpdates.prepare']['result'][] = [
  { preparation }, { preparation, nativeSession: null }, { preparation, nativeSession }, null,
];
const location: ExecutorRpcMethods['nativeSessions.describeSource']['result'] = {
  kind: 'provider-reference', value: 'fixture-native-source',
};
const literal: NonNullable<IntegrationManifest['literalExecution']> = {
  selectionLabel: 'Fixture format', inputFormatByModel: { 'fixture-model': 'plain' },
};
const attachments: NonNullable<IntegrationManifest['attachments']> = { fileMimeTypes: 'any', inlineTextMaxBytes: 4096 };
const readiness: ExecutorRpcMethods['readiness.status']['result'] = { ready: false, reason: 'Synthetic unavailability' };
const catalogRead: ExecutorRpcMethods['catalog.snapshot']['request'] = { strict: true, requireNativeDiscovery: true };
const catalog: ExecutorRpcMethods['catalog.snapshot']['result'] = {
  models: [{ value: 'fixture-model', label: 'Fixture model', supportsImages: false }],
  defaultModel: 'fixture-model', requiresStrictModelDiscovery: false, generation: { priority: 2, model: 'fixture-model' },
};
const chatScope = { kind: 'chat', recordId: 'fixture-chat', selectedAgentId: 'codex' } as const;
const legacyModel: ExecutorRpcMethods['migration.translateLegacyModel']['request'] = { scope: chatScope, model: 'legacy-model' };
const legacyValues = { fixture: JSON.parse('{"10":10,"2":2,"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}') };
const legacySession: ExecutorRpcMethods['migration.translateLegacyNativeSession']['request'] = {
  chatId: chat.chatId, projectPath: chat.projectPath, model: chat.model,
  agentSessionId: null, legacyNativePath: '/work/fixture-history', legacyValues,
};
const legacySettings: readonly ExecutorRpcMethods['migration.translateLegacySettings']['request'][] = [
  { scope: chatScope, legacyValues },
  { scope: { kind: 'execution-defaults', recordId: 'global', selectedAgentId: null }, legacyValues },
];
const auth: ExecutorRpcMethods['auth.status']['result'] = {
  authenticated: true, canReauth: false, label: 'Fixture login', source: 'cli',
};
const launched: ExecutorRpcMethods['auth.launchLogin']['result'] = {
  launched: true, alreadyRunning: false, sessionId: 'login-fixture', deviceAuth: { url: 'https://example.invalid', needsCode: true },
};
const codeSubmitted: ExecutorRpcMethods['auth.completeLogin']['result'] = { submitted: true, sessionId: 'login-fixture' };
const login: ExecutorRpcMethods['auth.loginStatus']['result'] = { state: 'running', running: true, sessionId: 'login-fixture', completionPending: false };
const commands: ExecutorRpcMethods['commands.discover']['result'] = [{ name: 'fixture', source: 'command', description: 'Synthetic command' }];
const steerCapture: ExecutorRpcMethods['steering.captureTarget']['request'] = {
  chatId: chat.chatId, agentSessionId: 'fixture-session', nativeSession, producerBinding: context.producerBinding, expectedRunId: 'fixture-run',
};
const target = resource('steer-target');
const steer: ExecutorRpcMethods['steering.steer']['request'] = {
  chatId: chat.chatId, projectPath: chat.projectPath, agentSessionId: 'fixture-session', nativeSession, target,
  input: 'Synthetic steer', clientMessageId: 'fixture-message',
};
const steerResults: readonly ExecutorRpcMethods['steering.steer']['result'][] = [
  { kind: 'accepted' }, { kind: 'rejected', reason: 'turn-changed', message: 'Synthetic rejection' },
  { kind: 'failed', outcome: 'unknown', message: 'Synthetic uncertainty' },
];
const endpoint: ExecutorRpcMethods['endpoints.validate']['request'] = {
  apiProviderId: 'fixture-provider', endpointId: 'main', providerLabel: 'Fixture',
  protocol: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'fixture-model',
  isLocal: false, capabilities: null, headers: {}, credential: null,
};
const query: ExecutorRpcMethods['singleQuery.run']['request'] = {
  prompt: 'Synthetic query', model: 'fixture-model', thinkingMode: 'none', timeoutMs: 1000.5, settings, endpoint,
};
for (const value of [
  start, resume, handle, sessions, configuration, apply, prepare, ...prepared, location,
  literal, attachments, readiness, catalogRead, catalog, legacyModel, legacySession, ...legacySettings,
  auth, launched, codeSubmitted, login, commands, steerCapture, target, steer, ...steerResults, endpoint, query, nativeSession,
]) {
  console.log(JSON.stringify(value));
}
