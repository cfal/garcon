import { describe, expect, it } from 'bun:test';
import {
  LOCAL_CAPABILITY_PREFIX,
  parseServerRuntimeDescriptor,
  parseServerRuntimeProbe,
} from '../server-runtime.js';

const capability = `${LOCAL_CAPABILITY_PREFIX}${'a'.repeat(43)}`;
const proof = 'b'.repeat(43);

describe('server runtime contracts', () => {
  it('accepts explicit trust only on HTTPS descriptors', () => {
    const descriptor = {
      schemaVersion: 1, instanceId: 'instance-1', workspaceDir: '/workspace',
      startedAt: '2026-07-31T12:00:00.000Z', pid: 123,
      baseUrl: 'https://127.0.0.1:8443', localCapability: capability,
      tlsTrust: { kind: 'system-ca' },
    };
    expect(parseServerRuntimeDescriptor(descriptor)).toEqual(descriptor);
    expect(() => parseServerRuntimeDescriptor({ ...descriptor, baseUrl: 'http://127.0.0.1:8080' }))
      .toThrow('tlsTrust');
    expect(() => parseServerRuntimeDescriptor({ ...descriptor, tlsTrust: { kind: 'insecure' } }))
      .toThrow('tlsTrust');
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
