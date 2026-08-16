import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

describe('transcript adoption architecture', () => {
  it('[TLV5-ADOPT.01-CORE-STATIC-01] keeps legacy adoption and native Reload facets at separate call sites', () => {
    const adoption = readFileSync(new URL('../adoption.ts', import.meta.url), 'utf8');
    const reload = readFileSync(new URL('../reload.ts', import.meta.url), 'utf8');
    const nativeSeed = readFileSync(new URL('../native-history-seed.ts', import.meta.url), 'utf8');

    expect(adoption).toContain('legacyHistoryImport');
    expect(adoption).not.toContain('nativeHistoryImport');
    expect(reload).toContain('nativeHistoryImport');
    expect(reload).not.toContain('legacyHistoryImport');
    expect(nativeSeed).toContain('nativeHistoryImport');
    expect(nativeSeed).not.toContain('legacyHistoryImport');
  });

  it('[TLV5-ADOPT.07-CORE-STATIC-01] keeps Direct migration parsing and provider identity out of core', () => {
    const directIds = [
      'direct-anthropic-compatible',
      'direct-openai-compatible',
      'direct-openai-responses-compatible',
    ];
    for (const file of productionFiles('server')) {
      const relative = path.relative('.', file);
      if (relative === 'server/agents/default-agent-integrations.ts') continue;
      const source = readFileSync(file, 'utf8');

      expect(source, relative).not.toContain('DirectSessionStore');
      for (const directId of directIds) {
        expect(source, relative).not.toContain(`@garcon/server-agent-${directId}`);
        expect(source, relative).not.toMatch(new RegExp(`agentId\\s*===?\\s*['\"]${directId}`));
      }
    }
  });
});

function productionFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '__tests__' || entry === 'build' || entry === 'node_modules') return [];
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) return productionFiles(file);
    return /\.(?:js|ts)$/.test(file) ? [file] : [];
  });
}
