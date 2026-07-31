import packageJson from '../package.json' with { type: 'json' };
import { CLI_HELP, parseCliArgs } from './args.js';
import { runConsultation } from './consultation.js';
import { discoverRuntime } from './discovery.js';
import { CliError } from './errors.js';
import { GarconClient } from './garcon-client.js';
import { createCliOutput } from './output.js';

export interface MainOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  readStdin?: () => Promise<string>;
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
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
    const prompt = command.readsPromptFromStdin
      ? await (options.readStdin ?? (() => Bun.stdin.text()))()
      : command.prompt ?? '';
    if (prompt.trim().length === 0) {
      throw new CliError('arguments', 'the prompt read from stdin must not be empty', 2);
    }
    const connection = await discoverRuntime({
      configDir: command.configDir,
      workspace: command.workspace,
      serverUrl: command.serverUrl,
      signal: options.signal,
    }, { fetch: options.fetch });
    const client = new GarconClient({ ...connection, fetch: options.fetch });
    await runConsultation(command, prompt, client, output, options.signal);
    return 0;
  } catch (error) {
    if (options.signal?.aborted) {
      output.diagnostic('receipt polling: terminal interrupted; the Garcon agent was not stopped');
      return 130;
    }
    const cliError = error instanceof CliError
      ? error
      : new CliError('submission', error instanceof Error ? error.message : String(error), 3);
    output.diagnostic(`${cliError.phase}: ${cliError.message}`);
    return cliError.exitCode;
  }
}

if (import.meta.main) {
  const interrupt = new AbortController();
  const onInterrupt = () => interrupt.abort(new Error('terminal interrupted'));
  process.once('SIGINT', onInterrupt);
  try {
    process.exitCode = await main(Bun.argv.slice(2), { signal: interrupt.signal });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
