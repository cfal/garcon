import { describe, expect, test } from 'bun:test';
import { createPathNativeSessionCodec } from '../path-native-session.js';

describe('createPathNativeSessionCodec', () => {
  test('preserves the version-one envelope and validates ownership', () => {
    const codec = createPathNativeSessionCodec('test');
    const reference = codec.encode({
      path: '/session.jsonl',
      agentSessionId: 'session',
      modelEndpointId: null,
    });
    expect(reference).toEqual({
      ownerId: 'test',
      schemaVersion: 1,
      value: { path: '/session.jsonl', agentSessionId: 'session' },
    });
    expect(codec.decode(reference)).toEqual({
      path: '/session.jsonl',
      agentSessionId: 'session',
      modelEndpointId: null,
    });
    expect(codec.encode({ path: null, agentSessionId: null, modelEndpointId: null })).toBeNull();
    expect(() => codec.decode({ ...reference!, ownerId: 'other' })).toThrow('Invalid native session');
  });
});
