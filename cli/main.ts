import packageJson from '../package.json' with { type: 'json' };
import fs from 'node:fs/promises';
import { CLI_HELP, parseCliArgs } from './args.js';
import { runConsultation } from './consultation.js';
import { discoverRuntime } from './discovery.js';
import { CliError } from './errors.js';
import { GarconClient } from './garcon-client.js';
import { createCliOutput, type CliOutput } from './output.js';

export interface MainOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  readStdin?: () => Promise<string>;
  output?: CliOutput;
}

async function readPromptFromStdin(
  reader: () => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!signal) return reader();
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('terminal interrupted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function canonicalProjectDirectory(cwd: string): Promise<string> {
  try {
    const canonical = await fs.realpath(cwd);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('path is not a directory');
    return canonical;
  } catch (error) {
    throw new CliError('arguments', `--cwd must identify an existing directory: ${cwd}`, 2, {
      cause: error,
    });
  }
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  const output = options.output ?? createCliOutput();
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
      ? await readPromptFromStdin(options.readStdin ?? (() => Bun.stdin.text()), options.signal)
      : command.prompt ?? '';
    if (prompt.trim().length === 0) {
      throw new CliError('arguments', 'the prompt read from stdin must not be empty', 2);
    }
    const invocation = command.kind === 'start'
      ? { ...command, cwd: await canonicalProjectDirectory(command.cwd) }
      : command;
    const connection = await discoverRuntime({
      configDir: invocation.configDir,
      workspace: invocation.workspace,
      serverUrl: invocation.serverUrl,
      signal: options.signal,
    }, { fetch: options.fetch });
    const client = new GarconClient({ ...connection, fetch: options.fetch });
    await runConsultation(invocation, prompt, client, output, options.signal);
    return 0;
  } catch (error) {
    if (options.signal?.aborted) {
      output.diagnostic('terminal interrupted; no Garcon agent was stopped');
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
