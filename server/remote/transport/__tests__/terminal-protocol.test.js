import { expect, test } from 'bun:test';
import { validateTerminalRpc } from '../terminal-protocol.ts';

const authority = { key: 'synthetic-user', expiresAtMs: null };
const terminalId = 'synthetic-terminal';
const attachmentId = 'synthetic-attachment';
const requests = [
  ['terminals.list', {}],
  ['terminals.create', { requestId: 'create', requestedInitialWorkingDirectory: null }],
  ['terminals.rename', { terminalId, title: 'Build logs' }],
  ['terminals.terminate', { terminalId, requestId: 'terminate' }],
  ['terminals.attach', {
    type: 'terminal-attach', terminalId, attachmentId,
    clientId: 'synthetic-browser', afterSequence: 0, intent: 'restore',
  }],
  ['terminals.input', { type: 'terminal-input', terminalId, attachmentId, data: 'pwd\r' }],
  ['terminals.resize', { type: 'terminal-resize', terminalId, attachmentId, cols: 80, rows: 24 }],
  ['terminals.detach', { type: 'terminal-detach', terminalId, attachmentId }],
];

test.each(requests)('validates the payload for %s without mutating it', (method, payload) => {
  const request = { ...payload, authority };
  const before = structuredClone(request);
  expect(() => validateTerminalRpc({ method, request })).not.toThrow();
  expect(request).toEqual(before);
});

test.each(requests)('requires delegated authority for %s', (method, payload) => {
  expect(() => validateTerminalRpc({ method, request: payload })).toThrow('Invalid terminal RPC request.');
  expect(() => validateTerminalRpc({ method, request: { ...payload, authority: { key: '', expiresAtMs: null } } }))
    .toThrow('Invalid terminal RPC request.');
});

test.each(requests.filter(([, request]) => 'type' in request))(
  'requires an attachment and a matching stream type for %s',
  (method, payload) => {
    const request = { ...payload, authority };
    expect(() => validateTerminalRpc({ method, request: { ...request, attachmentId: undefined } }))
      .toThrow('Invalid terminal RPC request.');
    const otherMethod = method === 'terminals.input' ? 'terminals.detach' : 'terminals.input';
    expect(() => validateTerminalRpc({ method: otherMethod, request }))
      .toThrow('Invalid terminal RPC request.');
  },
);

test.each([
  ['terminals.create', { requestId: '' }],
  ['terminals.rename', { terminalId, title: '\n' }],
  ['terminals.terminate', { terminalId }],
  ['terminals.attach', { type: 'terminal-attach', terminalId, attachmentId, clientId: 'browser', afterSequence: -1, intent: 'restore' }],
  ['terminals.input', { type: 'terminal-input', terminalId, attachmentId, data: 42 }],
  ['terminals.resize', { type: 'terminal-resize', terminalId, attachmentId, cols: 0, rows: 24 }],
  ['terminals.detach', { type: 'terminal-detach', attachmentId }],
])('rejects malformed %s payloads', (method, payload) => {
  expect(() => validateTerminalRpc({ method, request: { ...payload, authority } }))
    .toThrow('Invalid terminal RPC request.');
});
