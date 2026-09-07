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

const serverPackage = JSON.parse(readFileSync('server/package.json', 'utf8'));
const providerPackages = Object.keys(serverPackage.dependencies)
  .filter((name) => name.startsWith('@garcon/server-agent-'))
  .filter((name) => !name.endsWith('-interface') && !name.endsWith('-common'))
  .sort();
const providerIds = providerPackages.map((packageName) => {
  const directory = packageName.slice('@garcon/server-agent-'.length);
  const manifest = JSON.parse(readFileSync(`server-agents/${directory}/package.json`, 'utf8'));
  return manifest.garconBuild.integrationId;
});

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

  test('uses direct integrations without a legacy compatibility layer', () => {
    expect(existsSync(join('server-agents/common/src', 'legacy'))).toBe(false);
    const commonPackage = JSON.parse(readFileSync('server-agents/common/package.json', 'utf8'));
    expect(Object.keys(commonPackage.exports)).not.toContain('./legacy/*');

    for (const providerId of providerIds) {
      const source = readFileSync(`server-agents/${providerId}/src/index.ts`, 'utf8');
      expect(source, providerId).toMatch(
        /export default class \w+Integration implements AgentIntegration/,
      );
    }
  });

  test('imports provider packages only from the default composition module', () => {
    for (const file of walk('server')) {
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      for (const packageName of providerPackages) {
        if (source.includes(packageName)) {
          expect(relative('.', file), packageName).toBe('server/agents/default-agent-integrations.ts');
        }
      }
    }
  });

  test('keeps the public interface provider-free and runtime-light', () => {
    for (const file of walk('server-agents/interface/src')) {
      const source = readFileSync(file, 'utf8');
      for (const packageName of providerPackages) expect(source, file).not.toContain(packageName);
      expect(source, file).not.toMatch(/\b(?:Worker|SQLite|FTS5?|source-kind)\b/i);
    }
  });

  test('[TLV5-L12.02-STATIC-01] keeps the common toolkit independent of providers and core', () => {
    for (const file of walk('server-agents/common/src')) {
      const source = readFileSync(file, 'utf8');
      for (const packageName of providerPackages) expect(source, file).not.toContain(packageName);
      expect(source, file).not.toMatch(/(?:^|['"])\.{1,2}\/.*server\//m);
    }
  });

  test('routes transcript events through concrete operation publishers', () => {
    expect(existsSync('server-agents/common/src/execution/run-tracker.ts')).toBe(false);

    const productionSources = walk('server-agents').filter((file) => !file.includes('__tests__'));
    for (const file of productionSources) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bAgentRunTracker\b|execution\/run-tracker|subscribeRuntimeEvents/);
    }

    const executionAdapters = productionSources.filter((file) =>
      readFileSync(file, 'utf8').includes('implements AgentRuntimeExecution'));
    expect(executionAdapters.length).toBeGreaterThan(0);
    for (const file of executionAdapters) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('AgentRuntimePublisher');
      expect(source, file).not.toMatch(/\.on(?:Messages|Finished|Failed)\s*\(/);
    }
  });

  test('stops handoff recovery before graceful shutdown drains dependencies', () => {
    const source = readFileSync('server/server.ts', 'utf8');
    const shutdownStart = source.indexOf('const shutdown = async () =>');
    const handoffStop = source.indexOf('handoffs.shutdown()', shutdownStart);
    const executionAbort = source.indexOf('abortRunningSessionsWithTimeout({', shutdownStart);
    const ledgerClose = source.indexOf('transcriptLedger.close()', shutdownStart);

    expect(shutdownStart).toBeGreaterThanOrEqual(0);
    expect(handoffStop).toBeGreaterThan(shutdownStart);
    expect(handoffStop).toBeLessThan(executionAbort);
    expect(handoffStop).toBeLessThan(ledgerClose);
  });

  test('forwards canonical controls through every single-query integration', () => {
    for (const providerId of providerIds) {
      const source = readFileSync(`server-agents/${providerId}/src/index.ts`, 'utf8');
      if (!source.includes('this.singleQuery =')) continue;
      expect(source, providerId).toContain('singleQueryRuntimeOptions(request)');
      expect(source, providerId).not.toMatch(
        /this\.singleQuery = \{[\s\S]*?\.\.\.request\.settings\.values/,
      );
    }
  });

  test('[TLV5-L12.01-STATIC-01] keeps generic server modules out of provider implementation paths', () => {
    for (const root of ['server/chats', 'server/routes', 'server/ws']) {
      for (const file of walk(root)) {
        if (file.includes('__tests__')) continue;
        const source = readFileSync(file, 'utf8');
        for (const providerId of providerIds) {
          expect(source, file).not.toContain(`server-agents/${providerId}`);
          expect(source, file).not.toContain(`agents/${providerId}`);
        }
      }
    }
  });

  test('keeps ledger conversation projection out of the universal execution contract', () => {
    const productionSources = [
      ...walk('server-agents').filter((file) => !file.includes('__tests__')),
      ...walk('server/agents').filter((file) => !file.includes('__tests__')),
    ];
    for (const file of productionSources) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('priorContext');
    }

    const router = readFileSync('server/agents/runtime-router.ts', 'utf8');
    expect(router.split('conversationMessages(')).toHaveLength(2);
    expect(router.indexOf('conversationMessages(')).toBeLessThan(
      router.indexOf('integration.execution.start('),
    );
  });

  test('discovers build contributions from package metadata', () => {
    const source = readFileSync('scripts/build-exe.js', 'utf8');
    expect(source).toContain('collectAgentBuildContributions');
    expect(source).not.toContain('server/agents/pi');
    expect(source).not.toContain('server/chats/search/worker');
  });
});
