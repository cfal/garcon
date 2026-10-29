import { describe, expect, it } from 'bun:test';
import {
  LOCAL_CAPABILITY_PREFIX,
  parseServerRuntimeDescriptor,
  parseServerRuntimeProbe,
  parseCliContext,
  parseCliIdentity,
} from '../server-runtime.js';

const capability = `${LOCAL_CAPABILITY_PREFIX}${'a'.repeat(43)}`;
const proof = 'b'.repeat(43);

describe('server runtime contracts', () => {
  it('keeps CLI HTTP discovery versioned and reverse describe identity-only', () => {
    const identity = { serverInstanceId: 'synthetic-controller', defaultExecutorId: 'local', workspaceName: null };
    const context = { ...identity, protocol: { bootstrap: 1, contracts: { 'cli.chats.list': [1, 3] } } };
    expect(parseCliIdentity(identity)).toEqual(identity);
    expect(parseCliContext(context)).toEqual(context);
    expect(Object.isFrozen(parseCliContext(context).protocol.contracts['cli.chats.list'])).toBe(true);
    for (const protocol of [undefined, { bootstrap: 2, contracts: {} }, { bootstrap: 1, contracts: { 'files.read': [1] } }]) {
      expect(() => parseCliContext({ ...identity, protocol })).toThrow('unsupported CLI bootstrap');
    }
  });
  it('parses a runtime descriptor and normalizes its base URL', () => {
    expect(parseServerRuntimeDescriptor({
      schemaVersion: 1,
      instanceId: 'instance-1',
      workspaceDir: '/tmp/workspace-default',
      startedAt: '2026-07-31T12:00:00.000Z',
      pid: 123,
      baseUrl: 'http://127.0.0.1:8080/',
      localCapability: capability,
    })).toMatchObject({
      instanceId: 'instance-1',
      baseUrl: 'http://127.0.0.1:8080',
      localCapability: capability,
    });
  });

  it('keeps the credential-free probe minimal', () => {
    expect(parseServerRuntimeProbe({ schemaVersion: 1, instanceId: 'instance-1', proof })).toEqual({
      schemaVersion: 1,
      instanceId: 'instance-1',
      proof,
    });
  });

  it('rejects unsupported schemas and malformed capabilities', () => {
    expect(() => parseServerRuntimeProbe({ schemaVersion: 2, instanceId: 'instance-1', proof }))
      .toThrow('unsupported runtime schema version');
    expect(() => parseServerRuntimeProbe({ schemaVersion: 1, instanceId: 'instance-1', proof: 'short' }))
      .toThrow('proof must be 32-byte base64url data');
    expect(() => parseServerRuntimeDescriptor({
      schemaVersion: 1,
      instanceId: 'instance-1',
      workspaceDir: '/tmp/workspace-default',
      startedAt: '2026-07-31T12:00:00.000Z',
      pid: 123,
      baseUrl: 'http://127.0.0.1:8080',
      localCapability: 'secret',
    })).toThrow('localCapability is invalid');
  });
});
