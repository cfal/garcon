import packageJson from '../package.json' with { type: 'json' };
import { CLI_HELP, parseCliArgs } from './args.js';
import { CliError } from './errors.js';
import { createCliOutput } from './output.js';

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const output = createCliOutput();
  try {
    const command = parseCliArgs(argv);
    if (command.kind === 'help') {
      process.stdout.write(`${CLI_HELP}\n`);
      return 0;
    }
    if (command.kind === 'version') {
      process.stdout.write(`${packageJson.version}\n`);
      return 0;
    }
    throw new CliError('submission', 'the consultation client is unavailable', 3);
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError('submission', error instanceof Error ? error.message : String(error), 3);
    output.diagnostic(`${cliError.phase}: ${cliError.message}`);
    return cliError.exitCode;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
