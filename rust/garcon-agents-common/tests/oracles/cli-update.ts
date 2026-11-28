import { join } from 'node:path';
import { CliUpdateService } from '../../../../server-agents/common/src/cli-update/cli-update-service.ts';

const root = process.argv[2]!;
const service = new CliUpdateService({
  label: 'Synthetic CLI',
  definition: {
    packageName: '@anthropic-ai/claude-code',
    native: { ownsCommandPath: () => false, args: ['update'] },
  },
  target: async () => ({ command: join(root, 'npm-prefix/bin/claude'), bundled: false }),
  environment: () => ({ PATH: join(root, 'tools'), HOME: root }),
  nativeRelease: async () => ({ key: 'native', lookup: async () => null }),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  now: () => new Date('2026-11-20T00:00:00.000Z'),
});

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
