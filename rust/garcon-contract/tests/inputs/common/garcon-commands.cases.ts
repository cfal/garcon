import { mock } from 'bun:test';
import * as commands from '../../../../../common/garcon-commands.ts';

// The recorder accepts class instances in results, not in arguments. The
// extractor only reads own fields, so the original suites can pass those fields.
const { extractGarconCommands, ...otherExports } = commands;
mock.module('../../../../../common/garcon-commands.ts', () => ({
  ...otherExports,
  extractGarconCommands: (message: Parameters<typeof extractGarconCommands>[0]) =>
    extractGarconCommands({ ...message }),
}));

await import('../../../../../common/__tests__/garcon-commands.test.js');
await import('../../../../../common/__tests__/garcon-command-rejection.test.js');
await import('../../../../../common/__tests__/command-output.test.js');
await import('../../../../../common/__tests__/garcon-agent-prompt.test.js');
await import('../../../../../common/__tests__/garcon-ticket-command.test.js');
await import('../../../../../common/__tests__/garcon-resume-agent.test.js');
await import('../../../../../common/__tests__/garcon-stop-agent.test.js');
await import('../../../../../common/__tests__/async-user-questions.test.js');
