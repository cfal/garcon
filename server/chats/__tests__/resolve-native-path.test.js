import { describe, expect, it } from 'bun:test';
import { resolveMissingNativePath } from '../resolve-native-path.js';

describe('resolveMissingNativePath', () => {
  it('creates an artificial native path for direct OpenAI-compatible sessions', async () => {
    const path = await resolveMissingNativePath({
      provider: 'direct-openai-compatible',
      providerSessionId: 'session-123',
    });

    expect(path).toBe('!direct-openai-compatible:session-123');
  });

  it('creates an artificial native path for direct Anthropic-compatible sessions', async () => {
    const path = await resolveMissingNativePath({
      provider: 'direct-anthropic-compatible',
      providerSessionId: 'session-456',
    });

    expect(path).toBe('!direct-anthropic-compatible:session-456');
  });
});
