import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import DirectAnthropicCompatibleIntegration from '@garcon/server-agent-direct-anthropic-compatible';
import DirectOpenAiCompatibleIntegration from '@garcon/server-agent-direct-openai-compatible';
import DirectOpenAiResponsesCompatibleIntegration from '@garcon/server-agent-direct-openai-responses-compatible';

const DIRECT_REGISTRATIONS = [
  {
    binding: 'DirectAnthropicCompatibleIntegration',
    packageName: '@garcon/server-agent-direct-anthropic-compatible',
    Integration: DirectAnthropicCompatibleIntegration,
  },
  {
    binding: 'DirectOpenAiCompatibleIntegration',
    packageName: '@garcon/server-agent-direct-openai-compatible',
    Integration: DirectOpenAiCompatibleIntegration,
  },
  {
    binding: 'DirectOpenAiResponsesCompatibleIntegration',
    packageName: '@garcon/server-agent-direct-openai-responses-compatible',
    Integration: DirectOpenAiResponsesCompatibleIntegration,
  },
];

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
      const source = withoutAllowedDirectRegistrations(relative, readFileSync(file, 'utf8'));

      expect(source, relative).not.toContain('DirectSessionStore');
      expect(source, relative).not.toMatch(/@garcon\/server-agent-common\/direct\//);
      expect(source, relative).not.toMatch(/@garcon\/server-agent-direct-[^'"/]+\//);
      expect(source, relative).not.toMatch(/@garcon\/server-agent-direct-/);
      expect(source, relative).not.toMatch(/\.startsWith\(\s*['"`]direct-/);
      for (const { binding } of DIRECT_REGISTRATIONS) {
        expect(source, relative).not.toMatch(new RegExp(`\\b${binding}\\b`));
      }
      for (const directId of directIds) {
        expect(source, relative).not.toContain(directId);
        expect(source, relative).not.toMatch(new RegExp(`agentId\\s*===?\\s*['\"]${directId}`));
      }
      if (relative === 'server/agents/default-agent-integrations.ts') {
        expect(source, relative).not.toMatch(/\b(?:legacyHistoryImport|TranscriptAdoption|adoption)\b/);
      }
    }
  });

  it('[TLV5-ADOPT.07-DIRECT-STATIC-01] exposes a read-only Direct legacy importer without a session writer', () => {
    const directSources = productionFiles('server-agents/common/src/direct');
    expect(directSources.length).toBeGreaterThan(0);
    for (const file of directSources) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /\b(?:appendFile(?:Sync)?|writeFile(?:Sync)?|appendSync|writeSync|createWriteStream|FileSink)\b|\bBun\.write\b|\.writer\s*\(/,
      );
      expect(source, file).not.toMatch(
        /\b(?:open|openSync)\s*\([^\n]*['"`](?:w|wx|w\+|a|ax|a\+|ax\+)['"`]/,
      );
      expect(source, file).not.toContain('DirectSessionStore');
    }

    for (const { Integration } of DIRECT_REGISTRATIONS) {
      const integration = new Integration(createHost(Integration.integrationId));
      expect(Object.keys(integration.legacyHistoryImport ?? {}), Integration.integrationId)
        .toEqual(['load']);
      expect(integration.nativeHistoryImport, Integration.integrationId).toBeNull();
    }
  });
});

function withoutAllowedDirectRegistrations(relative, source) {
  if (relative !== 'server/agents/default-agent-integrations.ts') return source;
  let remaining = source;
  for (const { binding, packageName } of DIRECT_REGISTRATIONS) {
    const importLine = `import ${binding} from '${packageName}';`;
    const rosterLine = `  ${binding},`;
    expect(occurrences(remaining, importLine), `${binding} import count`).toBe(1);
    expect(occurrences(remaining, rosterLine), `${binding} roster count`).toBe(1);
    remaining = remaining.replace(importLine, '').replace(rosterLine, '');
  }
  return remaining;
}

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function createHost(agentId) {
  const rootDirectory = `/tmp/garcon-${agentId}-adoption-architecture`;
  const ignore = () => undefined;
  return {
    agentId,
    logger: { debug: ignore, info: ignore, warn: ignore, error: ignore },
    storage: {
      rootDirectory,
      directory: async () => rootDirectory,
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}

function productionFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '__tests__' || entry === 'build' || entry === 'node_modules') return [];
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) return productionFiles(file);
    return /\.(?:js|ts)$/.test(file) ? [file] : [];
  });
}
