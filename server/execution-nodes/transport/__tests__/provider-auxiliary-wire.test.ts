import { expect, test } from 'bun:test';
import { parseNodeWorkerServiceText, serializeNodeWorkerService } from '../../../execution-node/worker/service-protocol.js';
import { MAX_NODE_AUXILIARY_BYTES, parseNodeProviderAuxiliaryCommand, parseNodeProviderAuxiliaryReply, type NodeProviderAuxiliaryCommand } from '../provider-auxiliary-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const identity = { ...session, operationId: 'synthetic-operation' };
const command = { method: 'provider-text-generation', instanceId: 'synthetic-instance', identity,
  request: { prompt: 'synthetic prompt', timeoutMs: 30_000, configuration: { model: 'synthetic-model', settings: null, endpoint: null } },
} satisfies NodeProviderAuxiliaryCommand;
const envelope = { version: 1, session, connectionId: 1, requestId: 1 } as const;

test('auxiliary commands and replies survive strict parsing through both worker hops', () => {
  for (const request of [command, { ...command, method: 'provider-single-query', workspaceId: 'synthetic-workspace' }] as const) {
    const frame = { ...envelope, type: 'node-worker-service-request', command: request } as const;
    expect(parseNodeWorkerServiceText(serializeNodeWorkerService(frame))).toEqual(frame);
  }
  for (const result of [
    { kind: 'provider-auxiliary-result', instanceId: command.instanceId, identity, value: 'synthetic result' },
    { kind: 'provider-auxiliary-too-large', instanceId: command.instanceId, identity },
  ] as const) {
    const frame = { ...envelope, type: 'node-worker-service-result', result } as const;
    expect(parseNodeWorkerServiceText(serializeNodeWorkerService(frame))).toEqual(frame);
  }
});

test('auxiliary parsing rejects authority overrides, local paths, malformed budgets and oversized text', () => {
  for (const request of [
    { ...command, projectPath: '/foreign' },
    { ...command, workspaceId: 'foreign' },
    { ...command, method: 'provider-single-query' },
    { ...command, request: { ...command.request, configuration: { ...command.request.configuration, permissionMode: 'manualBypass' } } },
    ...[0, -1, 1.5, 300_001, Infinity].map((timeoutMs) => ({ ...command, request: { ...command.request, timeoutMs } })),
    { ...command, request: { ...command.request, prompt: 'x'.repeat(MAX_NODE_AUXILIARY_BYTES) } },
  ]) expect(parseNodeProviderAuxiliaryCommand(request)).toBeNull();
  expect(parseNodeProviderAuxiliaryReply({ kind: 'provider-auxiliary-result', instanceId: command.instanceId, identity,
    value: 'x'.repeat(MAX_NODE_AUXILIARY_BYTES) })).toBeNull();
  expect(parseNodeProviderAuxiliaryReply({ kind: 'provider-auxiliary-too-large', instanceId: command.instanceId, identity, value: '' })).toBeNull();
});

test('auxiliary identities cannot cross the worker envelope logical session', () => {
  const foreign = { ...identity, logicalSessionId: 'foreign-session' };
  expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-request', command: { ...command, identity: foreign } }))).toBeNull();
  expect(parseNodeWorkerServiceText(JSON.stringify({ ...envelope, type: 'node-worker-service-result',
    result: { kind: 'provider-auxiliary-result', instanceId: command.instanceId, identity: foreign, value: '' } }))).toBeNull();
});
