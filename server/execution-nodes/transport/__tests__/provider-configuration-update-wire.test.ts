import { expect, mock, test } from 'bun:test';
import type { AgentSessionConfiguration } from '@garcon/server-agent-interface';
import type { ProviderConfigurationUpdateRequest } from '../../provider-configuration.js';
import { parseNodeProviderConfiguration } from '../provider-configuration-wire.js';
import {
  captureNodeConfigurationUpdateRequest, captureNodeProviderConfigurationReply,
  MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES, MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES,
  parseNodeConfigurationUpdate, parseNodeConfigurationUpdateRequest,
  parseNodeProviderConfigurationCommand, parseNodeProviderConfigurationReply,
  type NodeProviderConfigurationCommand, type NodeProviderConfigurationReply,
} from '../provider-configuration-update-wire.js';

function parseSessionSnapshot(value: unknown): AgentSessionConfiguration | null {
  return parseNodeConfigurationUpdate({ previous: value, next: value })?.next ?? null;
}

function configuration() {
  return { model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
    settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { nested: { enabled: true as boolean } } },
    endpoint: { apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic endpoint',
      protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model', isLocal: false,
      capabilities: { chatCompletions: true, responses: false }, headers: { 'X-Synthetic': 'original' } } } satisfies AgentSessionConfiguration;
}

function request(): ProviderConfigurationUpdateRequest {
  return { previous: configuration(), next: { model: 'synthetic-next', endpoint: null },
    patch: { permissionMode: 'plan', settings: { nested: { enabled: false } } } };
}

test('settings snapshots own their complete normalized configuration without admitted credentials', () => {
  const input = { previous: configuration(), next: configuration() };
  const parsed = parseNodeConfigurationUpdate(input);
  expect(parsed).toEqual(input);
  input.next.settings.values.nested = { enabled: false };
  input.next.endpoint!.headers['X-Synthetic'] = 'changed';
  expect(parsed).toEqual({ previous: configuration(), next: configuration() });
  const admitted = { ...configuration(), endpoint: { selection: configuration().endpoint, credential: 'synthetic-secret' } };
  expect(parseNodeProviderConfiguration(admitted)).toEqual(admitted);
  expect(parseSessionSnapshot(admitted)).toBeNull();
  expect(parseSessionSnapshot({ ...configuration(), credential: 'synthetic-secret' })).toBeNull();
  expect(parseSessionSnapshot({ ...configuration(), endpoint: { ...configuration().endpoint, credential: 'synthetic-secret' } })).toBeNull();
});

test('prepared snapshots require explicit modes and parsed settings while requests retain native defaults', () => {
  expect(parseNodeConfigurationUpdateRequest({ previous: { model: '', endpoint: null, settings: null },
    next: { model: '', endpoint: null }, patch: {} })).not.toBeNull();
  for (const key of ['permissionMode', 'thinkingMode', 'settings', 'endpoint']) {
    const input: Record<string, unknown> = { ...configuration() };
    delete input[key];
    expect(parseSessionSnapshot(input)).toBeNull();
  }
  expect(parseSessionSnapshot({ ...configuration(), settings: null })).toBeNull();
  expect(parseSessionSnapshot({ ...configuration(), thinkingMode: 'think-hard' })).toBeNull();
});

test('update capture removes undefined optional request fields without accepting them on the wire', () => {
  const input = request();
  const optional = { ...input, previous: { ...input.previous, permissionMode: undefined, thinkingMode: undefined },
    patch: { permissionMode: undefined, thinkingMode: undefined, settings: undefined } };
  expect(parseNodeConfigurationUpdateRequest(optional)).toBeNull();
  expect(captureNodeConfigurationUpdateRequest(optional)).toEqual({ ...input,
    previous: { model: input.previous.model, endpoint: input.previous.endpoint, settings: input.previous.settings }, patch: {} });
  expect(captureNodeConfigurationUpdateRequest({ ...input, patch: { settings: { invalid: undefined } } } as unknown as ProviderConfigurationUpdateRequest)).toBeNull();
});

test('updates reject credentials, unknown fields, malformed envelopes, and unsafe endpoints in either snapshot', () => {
  for (const key of ['previous', 'next'] as const) {
    const input = request();
    for (const change of [
      { credential: 'synthetic-secret' }, { model: 42 },
      { endpoint: { ...configuration().endpoint, baseUrl: 'file:///synthetic' } },
      { endpoint: { selection: configuration().endpoint, credential: null } },
    ]) expect(parseNodeConfigurationUpdateRequest({ ...input, [key]: { ...input[key], ...change } })).toBeNull();
  }
  expect(parseNodeConfigurationUpdateRequest({ ...request(), patch: { thinkingMode: 'legacy-effort' } })).toBeNull();
  expect(parseNodeConfigurationUpdateRequest({ ...request(), patch: { settings: [] } })).toBeNull();
  expect(parseNodeConfigurationUpdateRequest({ ...request(), previous: { ...configuration(), settings: {
    ownerId: 'synthetic-provider', schemaVersion: 1, values: {}, extra: true,
  } } })).toBeNull();
});

test('configuration parsers and capture never invoke executable input', () => {
  const touched = mock(() => { throw new Error('Must not execute'); });
  const accessor = Object.defineProperty(configuration(), 'model', { get: touched, enumerable: true });
  const proxy = new Proxy(configuration(), { get: touched, ownKeys: touched });
  for (const input of [accessor, proxy, { ...configuration(), settings: { ...configuration().settings, values: { toJSON: touched } } }]) {
    expect(parseSessionSnapshot(input)).toBeNull();
    expect(parseNodeProviderConfiguration({ ...request().previous, settings: input })).toBeNull();
    expect(parseNodeConfigurationUpdate({ previous: input, next: configuration() })).toBeNull();
    expect(captureNodeProviderConfigurationReply('synthetic-instance', { previous: input, next: configuration() } as never)).toBeNull();
    const update = { ...request(), previous: input };
    expect(parseNodeConfigurationUpdateRequest(update)).toBeNull();
    expect(captureNodeConfigurationUpdateRequest(update as unknown as ProviderConfigurationUpdateRequest)).toBeNull();
  }
  expect(touched).not.toHaveBeenCalled();
});

test('normalized replies have room for defaults added to an accepted partial request', () => {
  const endpoint = { ...configuration().endpoint, headers: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`X-Synthetic-${index}`, 'h'.repeat(3690)])) };
  const input = { previous: { model: 'synthetic-model', settings: null, endpoint }, next: { model: 'synthetic-model', endpoint }, patch: {} };
  const command = { method: 'provider-configuration', operation: 'prepare-update', instanceId: 'synthetic-instance', request: input } satisfies NodeProviderConfigurationCommand;
  expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES);
  expect(parseNodeProviderConfigurationCommand(command)).toEqual(command);
  const normalized = { ...configuration(), endpoint, settings: { ...configuration().settings, values: { default: 'd'.repeat(4096) } } };
  const reply = captureNodeProviderConfigurationReply(command.instanceId, { previous: normalized, next: normalized });
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES);
  expect(reply).toEqual({ kind: 'provider-configuration-prepared', instanceId: command.instanceId, configuration: { previous: normalized, next: normalized } });
  expect(parseNodeProviderConfigurationReply(reply)).toEqual(reply);
  expect(parseNodeConfigurationUpdateRequest({ ...input, patch: { settings: { default: 'd'.repeat(8192) } } })).toBeNull();
});

test('capture distinguishes oversized normalized defaults from invalid provider data', () => {
  const normalized = { ...configuration(), settings: { ...configuration().settings, values: { default: 'd'.repeat(MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES) } } };
  const input = { previous: normalized, next: normalized };
  const refusal = { kind: 'provider-configuration-too-large', instanceId: 'synthetic-instance' } satisfies NodeProviderConfigurationReply;
  expect(captureNodeProviderConfigurationReply(refusal.instanceId, input)).toEqual(refusal);
  const excessive = { ...normalized, settings: { ...normalized.settings, values: { default: 'd'.repeat(5 * 1024 * 1024) } } };
  expect(captureNodeProviderConfigurationReply(refusal.instanceId, { previous: excessive, next: excessive })).toEqual(refusal);
  expect(parseNodeProviderConfigurationReply(refusal)).toEqual(refusal);
  expect(parseNodeProviderConfigurationReply({ ...refusal, configuration: input })).toBeNull();
  expect(captureNodeProviderConfigurationReply(refusal.instanceId, { ...input, next: { ...normalized, credential: 'synthetic-secret' } } as never)).toBeNull();
});

test('complete settings updates enforce a byte ceiling and reject cyclic or non-JSON values', () => {
  const input = { previous: configuration(), next: { ...configuration(), settings: {
    ...configuration().settings, values: { padding: 'é'.repeat(MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES / 2) },
  } } };
  expect(parseNodeConfigurationUpdate(input)).toBeNull();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const values of [cycle, { date: new Date() }, { number: BigInt(1) }, { missing: undefined }]) {
    expect(parseSessionSnapshot({ ...configuration(), settings: { ...configuration().settings, values } })).toBeNull();
  }
});
