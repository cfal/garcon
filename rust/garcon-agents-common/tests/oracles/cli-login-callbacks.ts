import { CliLoginController } from '../../../../server-agents/common/src/auth/cli-login-controller.ts';
import { readEnvironment } from '../../../../server-agents/common/src/environment/read-environment.ts';

const [mode, failedName] = process.argv.slice(2);
if (mode !== 'browser-code' && mode !== 'device-code') throw new Error('Unknown mode');

const calls: string[] = [];
const failure = new Error(`Synthetic read failure: ${failedName}`);
let sessionId: string | undefined;
const environment = {
  get(name: string) {
    const status = controller.status();
    if (status.state === 'running') sessionId = status.sessionId;
    calls.push(name);
    if (name === failedName) throw failure;
    return 'synthetic';
  },
};
const unexpectedSpawn = () => { throw new Error('Unexpected login spawn'); };
const noop = () => undefined;
const controller = new CliLoginController({
  mode,
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  command: () => [readEnvironment(environment, 'CLI_BINARY')!, 'login'],
  environment: () => ({ CLI_HOME: readEnvironment(environment, 'CLI_HOME')! }),
  spawnProcess: unexpectedSpawn,
  spawnPty: unexpectedSpawn,
});

try {
  await controller.launch();
  throw new Error('Unexpected successful launch');
} catch (error) {
  if (error !== failure || !sessionId) throw error;
  const terminal = controller.status(sessionId);
  if (terminal.state !== 'failed') throw new Error('Expected failed terminal state');
  process.stdout.write(JSON.stringify({
    error: failure.message,
    calls,
    idle: controller.status(),
    terminal: { state: terminal.state, running: terminal.running, error: terminal.error },
  }));
} finally {
  controller.stop();
}
