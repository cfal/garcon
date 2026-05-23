import { describe, expect, it, mock } from 'bun:test';
import { resolveMissingNativePath } from '../resolve-native-path.js';

describe('resolveMissingNativePath', () => {
  it('delegates native path lookup to a resolver function', async () => {
    const resolver = mock(async () => '/tmp/native.jsonl');

    const path = await resolveMissingNativePath({
      agentId: 'claude',
      agentSessionId: 'session-123',
    }, resolver);

    expect(path).toBe('/tmp/native.jsonl');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('delegates native path lookup to a resolver object', async () => {
    const resolver = {
      resolveNativePath: mock(async () => '!cursor:session-456'),
    };

    const path = await resolveMissingNativePath({
      agentId: 'cursor',
      agentSessionId: 'session-456',
    }, resolver);

    expect(path).toBe('!cursor:session-456');
    expect(resolver.resolveNativePath).toHaveBeenCalledTimes(1);
  });

  it('returns null when a session has no native session id', async () => {
    const resolver = mock(async () => '/tmp/native.jsonl');

    const path = await resolveMissingNativePath({
      agentId: 'claude',
      agentSessionId: null,
    }, resolver);

    expect(path).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});
