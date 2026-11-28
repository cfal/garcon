import { join } from 'node:path';
import { AgentIntegrationError } from '../../../../server-agents/interface/src/errors.ts';
import { CliUpdateService } from '../../../../server-agents/common/src/cli-update/cli-update-service.ts';

const root = process.argv[2]!;
const environmentErrorMode = process.argv[3] === 'environment-error';
let environmentUnavailable = environmentErrorMode;
let environmentReads = 0;
let targetReads = 0;
const service = new CliUpdateService({
  label: 'Synthetic CLI',
  definition: {
    packageName: '@anthropic-ai/claude-code',
    native: { ownsCommandPath: () => false, args: ['update'] },
  },
  target: async () => {
    targetReads++;
    return { command: join(root, 'npm-prefix/bin/claude'), bundled: environmentErrorMode };
  },
  environment: () => {
    environmentReads++;
    if (environmentUnavailable) {
      throw new AgentIntegrationError('UNAVAILABLE', 'synthetic environment read failed', true);
    }
    return { PATH: join(root, 'tools'), HOME: root };
  },
  nativeRelease: async () => ({ key: 'native', lookup: async () => null }),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  now: () => new Date('2026-11-20T00:00:00.000Z'),
});

if (environmentErrorMode) {
  const failure = (error: unknown) => {
    if (!(error instanceof AgentIntegrationError)) throw error;
    return { code: error.code, message: error.message, retryable: error.retryable };
  };
  const inspection = await service.status({ refresh: false }).then(() => null, failure);
  const update = await service.startUpdate().then(() => null, failure);
  environmentUnavailable = false;
  const recovered = await service.status({ refresh: false });
  process.stdout.write(JSON.stringify({ inspection, update, recovery: recovered.run.state, environmentReads, targetReads }));
} else {
  const before = await service.status({ refresh: false });
  await service.startUpdate();
  const deadline = Date.now() + 5_000;
  let after = await service.status({ refresh: false });
  while (after.run.state === 'running') {
    if (Date.now() >= deadline) throw new Error('The update did not settle');
    await Bun.sleep(5);
    after = await service.status({ refresh: false });
  }
  process.stdout.write(JSON.stringify({ before, after }));
}
