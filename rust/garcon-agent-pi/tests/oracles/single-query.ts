import { runSingleQuery } from '../../../../server-agents/pi/src/agents/pi/pi-cli.ts';
import type { PiConfig } from '../../../../server-agents/pi/src/config.ts';

const config: PiConfig = {
  binary: () => Bun.argv[2]!,
  homeDirectory: () => Bun.argv[3]!,
  agentDirectoryOverride: () => null,
  sessionDirectoryOverride: () => null,
  isTestEnvironment: () => true,
};
const options = { projectPath: Bun.argv[3], thinkingMode: 'high' };
const success = await runSingleQuery(' fixture prompt \n', {
  ...options, model: 'synthetic/success',
}, config);
let failure;
try {
  await runSingleQuery('x'.repeat(1024 * 1024), { ...options, model: 'synthetic/failure' }, config);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  failure = error.message;
}
process.stdout.write(JSON.stringify([success, failure]));
