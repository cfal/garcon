import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeProviderConfiguration } from '../provider-configuration-wire.js';
import { MAX_NODE_EXECUTION_BODY_BYTES, parseNodeExecutionBody, parseNodeExecutionBodyText, serializeNodeExecutionBody } from '../execution-body-wire.js';
import { parsePrivateNodeJson } from '../private-json.js';

const configuration = () => ({
  model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
  settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { nested: { enabled: true } } },
  endpoint: {
    selection: { apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic endpoint',
      protocol: 'openai-compatible' as const, baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model', isLocal: false,
      capabilities: { chatCompletions: true, responses: false }, headers: { 'X-Synthetic': 'original' } },
    credential: 'synthetic-private-credential',
  },
});

test('delegated configuration snapshots metadata and credential together and owns all nested values', () => {
  const input = configuration();
  const parsed = parseNodeProviderConfiguration(input);
  expect(parsed).toEqual(input);
  input.endpoint.credential = 'synthetic-replacement-credential';
  input.endpoint.selection.baseUrl = 'https://replacement.invalid';
  input.endpoint.selection.headers['X-Synthetic'] = 'changed';
  input.endpoint.selection.capabilities.responses = true;
  input.settings.values.nested.enabled = false;
  expect(parsed).toEqual(configuration());
});

test('native configuration keeps null endpoints and omitted modes for the owning provider to resolve', () => {
  const native = { model: '', settings: null, endpoint: null };
  expect(parseNodeProviderConfiguration(native)).toEqual(native);
});

test('unknown configuration fields, legacy effort aliases and late credential references are rejected', () => {
  const valid = configuration();
  for (const input of [
    { ...valid, signal: {} }, { ...valid, permissionMode: 'unsafe' }, { ...valid, thinkingMode: 'think-hard' },
    { ...valid, settings: { ...valid.settings, extra: true } },
    { ...valid, endpoint: { ...valid.endpoint, credential: { endpointId: 'synthetic-endpoint' } } },
    { ...valid, endpoint: { ...valid.endpoint, selection: { ...valid.endpoint.selection, credential: 'synthetic-reference' } } },
    { ...valid, endpoint: { ...valid.endpoint, selection: { ...valid.endpoint.selection, capabilities: { responses: true } } } },
  ]) expect(parseNodeProviderConfiguration(input)).toBeNull();
});

test('endpoint parsing refuses non-HTTP URLs and unsafe header framing before provider validation', () => {
  for (const selection of [
    { baseUrl: 'file:///synthetic' }, { baseUrl: 'https://synthetic.invalid?q=value' },
    { baseUrl: 'https://synthetic:credential@synthetic.invalid/v1' }, { baseUrl: 'https://synthetic@synthetic.invalid/v1' },
    { headers: { 'X-Synthetic': 'value\r\nAuthorization: synthetic' } },
  ]) {
    const input = configuration();
    Object.assign(input.endpoint.selection, selection);
    expect(parseNodeProviderConfiguration(input)).toBeNull();
  }
});

test('closed fields require their own values and reject executable or cyclic settings', () => {
  const input = configuration();
  expect(parseNodeProviderConfiguration(Object.assign(Object.create({ model: input.model }), {
    settings: input.settings, endpoint: input.endpoint, foreign: true,
  }))).toBeNull();
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(parseNodeProviderConfiguration({ ...input, settings: { ...input.settings, values: cyclic } })).toBeNull();
  expect(parseNodeProviderConfiguration({ ...input, settings: { ...input.settings, values: { toJSON() { throw new Error('Must not run'); } } } })).toBeNull();
});

test('execution, steering and goal bodies round-trip opaque text and normalized attachments', () => {
  const attachments = [{ kind: 'image' as const, name: null, mimeType: 'image/png', data: 'data:image/png;base64,c3ludGhldGlj' }];
  const execution = { kind: 'execution' as const, input: { prompt: 'synthetic\0input\ud800', attachments,
    carriedContext: { prefix: '<carried-context>synthetic</carried-context>', summaryTruncated: false } } };
  expect(parseNodeExecutionBody(serializeNodeExecutionBody(execution))).toEqual(execution);
  const goal = { kind: 'goal' as const, prompt: '/goal pause', attachments };
  expect(parseNodeExecutionBody(serializeNodeExecutionBody(goal))).toEqual(goal);
  const steer = { kind: 'steer' as const, input: 'synthetic guidance', clientMessageId: 'synthetic:message/id' };
  expect(parseNodeExecutionBody(serializeNodeExecutionBody(steer))).toEqual(steer);
});

test('body parsing rejects undeclared capabilities, incorrect versions, malformed UTF-8 and attachment mismatches', () => {
  const input = { prompt: 'synthetic', attachments: [], carriedContext: null };
  for (const value of [
    { version: 99, kind: 'execution', input },
    { version: NODE_WIRE_VERSION, kind: 'execution', input: { ...input, output: {} } },
    { version: NODE_WIRE_VERSION, kind: 'execution', input: { ...input, carriedContext: { prefix: 'synthetic', extra: true } } },
    { version: NODE_WIRE_VERSION, kind: 'goal', prompt: '', attachments: [{ kind: 'image', name: null,
      mimeType: 'image/jpeg', data: 'data:image/png;base64,c3ludGhldGlj' }] },
    { version: NODE_WIRE_VERSION, kind: 'steer', input: 'synthetic', clientMessageId: 'é'.repeat(129) },
  ]) expect(parseNodeExecutionBodyText(JSON.stringify(value))).toBeNull();
  expect(parseNodeExecutionBody(new Uint8Array([0xff, 0xfe]))).toBeNull();
});

test('private input bounds measure UTF-8 before parsing and refuse excessive JSON nesting', () => {
  expect(parsePrivateNodeJson('{"body":"éé"}', 14)).toBeNull();
  expect(parsePrivateNodeJson('{"body":"éé"}', 15)).toEqual({ body: 'éé' });
  const nested = '{"body":'.repeat(102) + 'null' + '}'.repeat(102);
  expect(parsePrivateNodeJson(nested, 4096)).toBeNull();
});

test('execution bodies enforce their own serialized byte bound on both directions', () => {
  const prompt = 'x'.repeat(MAX_NODE_EXECUTION_BODY_BYTES);
  const serialized = JSON.stringify({ version: NODE_WIRE_VERSION, kind: 'goal', prompt, attachments: [] });
  expect(parseNodeExecutionBodyText(serialized)).toBeNull();
  expect(parseNodeExecutionBody(new TextEncoder().encode(serialized))).toBeNull();
  expect(() => serializeNodeExecutionBody({ kind: 'goal', prompt, attachments: [] })).toThrow('Invalid node execution body');
});
