import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') return [];
    const filePath = join(dir, entry);
    if (statSync(filePath).isDirectory()) return walk(filePath);
    return /\.(?:ts|js)$/.test(filePath) ? [filePath] : [];
  });
}

const providerIds = [
  'amp',
  'claude',
  'codex',
  'cursor',
  'direct-anthropic-compatible',
  'direct-openai-compatible',
  'direct-openai-responses-compatible',
  'factory',
  'opencode',
  'pi',
];

describe('agent architecture boundaries', () => {
  test('moves every provider implementation into an isolated package', () => {
    for (const providerId of providerIds) {
      expect(existsSync(`server-agents/${providerId}/package.json`), providerId).toBe(true);
      expect(existsSync(`server-agents/${providerId}/src/index.ts`), providerId).toBe(true);
      expect(existsSync(`server/agents/${providerId}`), providerId).toBe(false);
    }
    expect(existsSync('server/acp')).toBe(false);
    expect(existsSync('server/agents/direct')).toBe(false);
  });

  test('imports provider packages only from the default composition module', () => {
    for (const file of walk('server')) {
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      if (source.includes('@garcon/server-agent-') && !source.includes('@garcon/server-agent-interface')) {
        expect(relative('.', file)).toBe('server/agents/default-agent-integrations.ts');
      }
    }
  });

  test('keeps the public interface provider-free and runtime-light', () => {
    for (const file of walk('server-agents/interface/src')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/server-agent-(?:amp|claude|codex|cursor|factory|opencode|pi)/);
      expect(source, file).not.toMatch(/\b(?:Worker|SQLite|FTS5?|source-kind)\b/i);
    }
  });

  test('keeps the common toolkit independent of providers and core', () => {
    for (const file of walk('server-agents/common/src')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/@garcon\/server-agent-(?:amp|claude|codex|cursor|factory|opencode|pi)/);
      expect(source, file).not.toMatch(/(?:^|['"])\.{1,2}\/.*server\//m);
    }
  });

  test('keeps generic server modules out of provider implementation paths', () => {
    for (const root of ['server/chats', 'server/routes', 'server/ws']) {
      for (const file of walk(root)) {
        if (file.includes('__tests__')) continue;
        const source = readFileSync(file, 'utf8');
        expect(source, file).not.toMatch(/server-agents\/(?:amp|claude|codex|cursor|factory|opencode|pi)/);
        expect(source, file).not.toMatch(/agents\/(?:amp|claude|codex|cursor|factory|opencode|pi)/);
      }
    }
  });

  test('discovers build contributions from package metadata', () => {
    const source = readFileSync('scripts/build-exe.js', 'utf8');
    expect(source).toContain('collectAgentBuildContributions');
    expect(source).not.toContain('server/agents/pi');
    expect(source).not.toContain('server/chats/search/worker');
  });
});
