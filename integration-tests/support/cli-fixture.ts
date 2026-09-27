import { readFileSync } from 'node:fs';
import { cliRuntimeFile, type RuntimeKind } from '../../common/cli-runtime-paths.js';
import { parseCliRuntimeDescriptor } from '../../common/server-runtime.js';
import { withIntegrationFixture, type IntegrationFixture, type IntegrationFixtureOptions } from './integration-fixture.js';

export type { IntegrationFixture, IntegrationFixtureOptions } from './integration-fixture.js';

export function cliRuntime(fixture: IntegrationFixture): RuntimeKind {
  return fixture.client.executorId === 'local' ? 'controller' : 'executor';
}

export function cliConnectionArguments(fixture: IntegrationFixture): string[] {
  const configDir = fixture.executionDirs.config;
  const runtime = cliRuntime(fixture);
  const descriptor = parseCliRuntimeDescriptor(JSON.parse(readFileSync(cliRuntimeFile(configDir, runtime), 'utf8')));
  return ['--config-dir', configDir, '--runtime', runtime, '--server', descriptor.baseUrl];
}

export function withCliFixture<T>(
  testName: string,
  run: (fixture: IntegrationFixture) => Promise<T>,
  options: IntegrationFixtureOptions = {},
): Promise<T> {
  return withIntegrationFixture(testName, async fixture => {
    if (fixture.client.executorId !== 'local') {
      await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { allowControllerCli: true });
    }
    return run(fixture);
  }, { projectRoots: 'separate', ...options });
}
