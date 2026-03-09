// Tests for humanizeCodexError -- verifies raw SDK/CLI errors are
// translated into actionable user-facing messages.

import { describe, it, expect } from 'bun:test';
import { humanizeCodexError } from '../codex.ts';

describe('humanizeCodexError', () => {
  it('detects missing CLI', () => {
    const msg = humanizeCodexError(new Error('spawn codex ENOENT'));
    expect(msg).toContain('not installed');
  });

  it('detects auth failure', () => {
    const msg = humanizeCodexError(new Error('401 Unauthorized'));
    expect(msg).toContain('authentication failed');
  });

  it('detects rate limit', () => {
    const msg = humanizeCodexError(new Error('429 rate limit exceeded'));
    expect(msg).toContain('rate limit');
  });

  it('detects invalid model', () => {
    const msg = humanizeCodexError(new Error('model gpt-99 does not exist'));
    expect(msg).toContain('model not available');
  });

  it('detects network errors', () => {
    const msg = humanizeCodexError(new Error('ECONNREFUSED 127.0.0.1:443'));
    expect(msg).toContain('network connection');
  });

  it('strips stack traces from exit code errors', () => {
    const msg = humanizeCodexError(
      new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n      at run (/home/user/node_modules/@openai/codex-sdk/dist/index.js:277:19)')
    );
    expect(msg).toContain('Codex process failed');
    expect(msg).not.toContain('at run');
    expect(msg).not.toContain('node_modules');
  });

  it('falls back to prefixed raw message for unknown errors', () => {
    const msg = humanizeCodexError(new Error('something unexpected'));
    expect(msg).toBe('Codex error: something unexpected');
  });

  it('handles string errors', () => {
    const msg = humanizeCodexError('raw string error');
    expect(msg).toBe('Codex error: raw string error');
  });
});
