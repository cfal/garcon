import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDirectSessionPaths } from '../session-paths.ts';

const createdDirs = [];

describe('Direct session paths', () => {
  it('builds endpoint-scoped paths under the injected workspace', () => {
    const paths = createDirectSessionPaths('/tmp/workspace', 'openai-compatible-sessions');

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
      'openai-compatible-responses-sessions',
    );
    const anthropic = createDirectSessionPaths(
      '/tmp/workspace',
      'anthropic-compatible-sessions',
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
    const paths = createDirectSessionPaths('/tmp/workspace', 'openai-compatible-sessions');

    expect(() => paths.sessionFilePath('../outside', 'session-1')).toThrow('endpoint ID');
    expect(() => paths.sessionFilePath('/outside', 'session-1')).toThrow('endpoint ID');
    expect(() => paths.sessionFilePath('acme_openai', '../outside')).toThrow('session ID');
    expect(() => paths.sessionFilePath('acme_openai', '/outside')).toThrow('session ID');
  });

  it('finds persisted sessions deterministically when endpoint metadata is stale', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-paths-'));
    createdDirs.push(root);
    const paths = createDirectSessionPaths(root, 'openai-compatible-sessions');
    await fs.mkdir(paths.sessionDir('endpoint_b'), { recursive: true });
    await fs.mkdir(paths.sessionDir('endpoint_a'), { recursive: true });
    await fs.writeFile(paths.sessionFilePath('endpoint_b', 'session-1'), '{}\n');
    await fs.writeFile(paths.sessionFilePath('endpoint_a', 'session-1'), '{}\n');

    await expect(paths.findSessionFilePath('session-1', 'endpoint_b')).resolves.toBe(
      paths.sessionFilePath('endpoint_b', 'session-1'),
    );
    await expect(paths.findSessionFilePath('session-1', 'missing')).resolves.toBe(
      paths.sessionFilePath('endpoint_a', 'session-1'),
    );
  });

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
