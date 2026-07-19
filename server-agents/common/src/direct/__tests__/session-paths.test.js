import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { createDirectSessionPaths } from '../session-paths.ts';

describe('Direct session paths', () => {
  it('builds endpoint-scoped paths under the injected workspace', () => {
    const paths = createDirectSessionPaths('/tmp/workspace', 'direct-openai-compatible');

    expect(paths.sessionDir('acme_openai')).toBe(path.resolve(
      '/tmp/workspace/openai-compatible-sessions/acme_openai',
    ));
    expect(paths.sessionFilePath('acme_openai', 'session-1')).toBe(path.resolve(
      '/tmp/workspace/openai-compatible-sessions/acme_openai/session-1.jsonl',
    ));
  });

  it('keeps each Direct agent in a separate session root', () => {
    const responses = createDirectSessionPaths(
      '/tmp/workspace',
      'direct-openai-responses-compatible',
    );
    const anthropic = createDirectSessionPaths(
      '/tmp/workspace',
      'direct-anthropic-compatible',
    );

    expect(responses.sessionFilePath('acme_openai', 'session-1')).toBe(path.resolve(
      '/tmp/workspace',
      'openai-compatible-responses-sessions',
      'acme_openai',
      'session-1.jsonl',
    ));
    expect(anthropic.sessionFilePath('acme_anthropic', 'session-1')).toBe(path.resolve(
      '/tmp/workspace',
      'anthropic-compatible-sessions',
      'acme_anthropic',
      'session-1.jsonl',
    ));
  });

  it('rejects traversal and absolute path segments', () => {
    const paths = createDirectSessionPaths('/tmp/workspace', 'direct-openai-compatible');

    expect(() => paths.sessionFilePath('../outside', 'session-1')).toThrow('endpoint ID');
    expect(() => paths.sessionFilePath('/outside', 'session-1')).toThrow('endpoint ID');
    expect(() => paths.sessionFilePath('acme_openai', '../outside')).toThrow('session ID');
    expect(() => paths.sessionFilePath('acme_openai', '/outside')).toThrow('session ID');
  });
});
