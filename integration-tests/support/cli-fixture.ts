import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cliRuntimeFile, type RuntimeKind } from '../../common/cli-runtime-paths.js';
import { parseCliRuntimeDescriptor } from '../../common/server-runtime.js';
import { cliEnvironment } from './cli-environment.js';
import { withIntegrationFixture, type IntegrationFixture, type IntegrationFixtureOptions } from './integration-fixture.js';

export type { IntegrationFixture, IntegrationFixtureOptions } from './integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function cliRuntime(fixture: IntegrationFixture): RuntimeKind {
  return fixture.client.executorId === 'local' ? 'controller' : 'executor';
}

// Remote lanes keep the controller's runtime under the fixture's own directories and the
// executor gateway's under the worker's, even though both are the same in-process.
function cliDirectories(fixture: IntegrationFixture, runtime: RuntimeKind) {
  return runtime === 'controller' ? fixture.dirs : fixture.executionDirs;
}

export function cliConnectionArguments(fixture: IntegrationFixture, runtime = cliRuntime(fixture)): string[] {
  const configDir = cliDirectories(fixture, runtime).config;
  const descriptor = parseCliRuntimeDescriptor(JSON.parse(readFileSync(cliRuntimeFile(configDir, runtime), 'utf8')));
  return ['--config-dir', configDir, '--runtime', runtime, '--server', descriptor.baseUrl];
}

export async function runCli(
  fixture: IntegrationFixture,
  arguments_: readonly string[],
  runtime = cliRuntime(fixture),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'cli/main.ts', ...cliConnectionArguments(fixture, runtime), ...arguments_],
    cwd: REPO_ROOT,
    env: cliEnvironment({ HOME: cliDirectories(fixture, runtime).home }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
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
