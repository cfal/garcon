import { describe, expect, it } from 'bun:test';
import { CodexAppServerRpcError } from '../client.ts';
import { humanizeCodexAppServerError } from '../runtime-support.ts';

describe('Codex provider admission errors', () => {
  it.each([
    'modelProviderMismatch',
    'modelProviderNotConfigured',
    'modelProviderPolicyConflict',
  ])('preserves %s messages instead of classifying provider names as failures', (type) => {
    const message = 'This chat uses synthetic-network-401-429-timeout-api-key, not found in the current configuration.';
    const error = new CodexAppServerRpcError(message, -32600, { type });
    expect(humanizeCodexAppServerError(error)).toBe(`Codex error: ${message}`);
  });

  it('keeps the normal fallback for unknown RPC errors', () => {
    const error = new CodexAppServerRpcError('Network timeout', -32600, { type: 'futureProviderError' });
    expect(humanizeCodexAppServerError(error)).toBe('Codex could not connect to the API. Check your network connection.');
  });

  it('suggests the executor override for a missing binary, not a missing model', () => {
    for (const message of ['Executable not found in $PATH: "codex"', 'spawn codex.exe ENOENT']) {
      expect(humanizeCodexAppServerError(new Error(message))).toContain('GARCON_CODEX_CLI');
    }
    expect(humanizeCodexAppServerError(new Error('Model not found'))).toContain('model not available');
  });
});
