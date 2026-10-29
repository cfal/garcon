import { expect, mock, test } from 'bun:test';
import type { ExecutionTerminalService, TerminalAuthority, TerminalPeer } from '@garcon/server-agent-interface';
import { WorkerSessionTransport } from '../../__tests__/test-session-transport.js';
import { ExecutorRpc } from '../../transport/rpc.js';
import { rpcWireV1 } from '../../transport/rpc-wire-v1.js';
import { TERMINAL_ATTACHMENT_CODEC_V1 } from '../../transport/terminal-protocol.js';
import { TerminalRpcServer } from '../terminal-rpc-server.js';

test('early output and fast detach use the captured attachment and refuse incompatible consumers', async () => {
  const transport = new WorkerSessionTransport('synthetic-session', 'controller', () => {});
  const sent: string[] = [];
  transport.attach({ send: payload => { sent.push(payload); }, close() {} });
  const rpc = new ExecutorRpc(transport);
  const entered = Promise.withResolvers<TerminalPeer>();
  const release = Promise.withResolvers<void>();
  const authority = { key: 'synthetic-owner', expiresAtMs: null };
  const attachmentId = 'synthetic-attachment';
  const terminalId = 'synthetic-terminal';
  const output = { type: 'terminal-output' as const, terminalId, sequence: 1, data: 'synthetic output' };
  const unused = async (): Promise<never> => { throw new Error('Unused terminal operation'); };
  const service = {
    list: unused, create: unused, rename: unused, terminate: unused,
    attach: mock(async (_authority: TerminalAuthority, peer: TerminalPeer) => {
      peer.sendTerminalMessage(output);
      entered.resolve(peer);
      await release.promise;
    }),
    input: mock(async () => {}), resize: mock(async () => {}), detachPeer: mock(() => {}), disconnect() {},
  } satisfies ExecutionTerminalService;
  const server = new TerminalRpcServer(service, rpc);
  const codec = TERMINAL_ATTACHMENT_CODEC_V1.codecs['terminal-output']!;
  const decode = mock(codec.decode);
  const creator = { ...TERMINAL_ATTACHMENT_CODEC_V1, codecs: { ...TERMINAL_ATTACHMENT_CODEC_V1.codecs,
    'terminal-output': { ...codec, decode } } };
  const attaching = server.handle({ method: 'terminals.attach', version: 1, request: {
    type: 'terminal-attach', authority, terminalId, attachmentId, clientId: 'synthetic-client', afterSequence: 0, intent: 'restore',
  } }, { ...rpcWireV1('terminals.attach'), terminal: creator });
  try {
    const peer = await entered.promise;
    expect(sent.map(payload => JSON.parse(payload))).toContainEqual({ type: 'terminal', attachmentId, message: output });
    expect(decode).toHaveBeenCalledTimes(1);
    const wire = rpcWireV1('terminals.input');
    const request = { type: 'terminal-input' as const, authority, terminalId, attachmentId, data: 'synthetic input' };
    await expect(server.handle({ method: 'terminals.input', version: 1, request }, {
      ...wire, definition: { ...wire.definition, acceptsResource: { ...creator.resource, version: 2 } },
    })).rejects.toMatchObject({ code: 'terminal-not-attached' });
    expect(service.input).not.toHaveBeenCalled();
    await server.handle({ method: 'terminals.input', version: 1, request }, wire);
    expect(service.input).toHaveBeenCalledTimes(1);
    await server.detach({ type: 'terminal-detach', authority, terminalId, attachmentId });
    expect(service.detachPeer).toHaveBeenCalledWith(authority, peer);
    peer.sendTerminalMessage({ ...output, sequence: 2 });
    expect(decode).toHaveBeenCalledTimes(1);
    release.resolve();
    await attaching;
    await server.detach({ type: 'terminal-detach', authority, terminalId, attachmentId });
    expect(service.detachPeer).toHaveBeenCalledTimes(1);
    expect(transport.connected).toBe(true);
  } finally { release.resolve(); await attaching; server.disconnect(); transport.close(); }
});
