import { describe, expect, it, mock } from 'bun:test';
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

  it('uses the Codex app-server resolver when reconciling Codex sessions', async () => {
    const resolveCodexNativePath = mock(async () => '/tmp/codex-thread.jsonl');

    const path = await resolveMissingNativePath({
      provider: 'codex',
      providerSessionId: 'thread-123',
    }, { resolveCodexNativePath });

    expect(path).toBe('/tmp/codex-thread.jsonl');
    expect(resolveCodexNativePath).toHaveBeenCalledTimes(1);
  });

  it('does not scan Codex rollout files when no app-server resolver is provided', async () => {
    const path = await resolveMissingNativePath({
      provider: 'codex',
      providerSessionId: 'thread-123',
    });

    expect(path).toBeNull();
  });
});
