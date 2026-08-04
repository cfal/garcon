import packageJson from '../package.json' with { type: 'json' };
import fs from 'node:fs/promises';
import { CLI_HELP, parseCliArgs, type ParsedCliCommand } from './args.js';
import { runCatalogQuery } from './catalog-query.js';
import { sendChatAsync, stopChat } from './chat-control.js';
import { runChatWait } from './chat-wait.js';
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
  // Overrides runtime discovery; production resolves the named workspace descriptor.
  discoverRuntime?: typeof discoverRuntime;
}

async function readDefaultStdin(signal?: AbortSignal): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let content = '';
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }
    signal?.throwIfAborted();
    return content + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
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

async function readConfiguredStdin(options: MainOptions): Promise<string> {
  return options.readStdin
    ? await readPromptFromStdin(options.readStdin, options.signal)
    : await readDefaultStdin(options.signal);
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

async function connectedClient(
  command: { configDir: string; workspace: string; serverUrl?: string },
  options: MainOptions,
): Promise<GarconClient> {
  const discover = options.discoverRuntime ?? discoverRuntime;
  const connection = await discover({
    configDir: command.configDir,
    workspace: command.workspace,
    serverUrl: command.serverUrl,
    signal: options.signal,
  }, { fetch: options.fetch });
  return new GarconClient({ ...connection, fetch: options.fetch });
}

function interruptDiagnostic(command: ParsedCliCommand | undefined): string {
  // A one-shot control POST may have reached the server before the terminal was
  // interrupted, so a conservative ambiguity message prevents an unsafe retry.
  return command !== undefined && (command.kind === 'send-async' || command.kind === 'stop')
    ? 'terminal interrupted; the control command may have reached Garcon; inspect the chat before retrying'
    : 'terminal interrupted; no Garcon agent was stopped';
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  const output = options.output ?? createCliOutput();
  let command: ParsedCliCommand | undefined;
  try {
    command = parseCliArgs(argv);
    if (command.kind === 'help') {
      process.stdout.write(`${CLI_HELP}\n`);
      return 0;
    }
    if (command.kind === 'version') {
      process.stdout.write(`${packageJson.version}\n`);
      return 0;
    }
    if (command.kind === 'list') {
      const client = await connectedClient(command, options);
      await runCatalogQuery(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'wait') {
      const client = await connectedClient(command, options);
      await runChatWait(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'stop') {
      const client = await connectedClient(command, options);
      await stopChat(command.chatId, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'send-async') {
      const message = command.readsMessageFromStdin
        ? await readConfiguredStdin(options)
        : command.message ?? '';
      if (message.trim().length === 0) {
        throw new CliError('arguments', 'the message read from stdin must not be empty', 2);
      }
      const client = await connectedClient(command, options);
      await sendChatAsync({
        chatId: command.chatId,
        content: message,
        allowSteer: command.allowSteer,
      }, client, output, options.signal);
      return 0;
    }
    const prompt = command.readsPromptFromStdin
      ? await readConfiguredStdin(options)
      : command.prompt ?? '';
    if (prompt.trim().length === 0) {
      throw new CliError('arguments', 'the prompt read from stdin must not be empty', 2);
    }
    const invocation = command.kind === 'start'
      ? { ...command, cwd: await canonicalProjectDirectory(command.cwd) }
      : command;
    const client = await connectedClient(invocation, options);
    await runConsultation(invocation, prompt, client, output, options.signal);
    return 0;
  } catch (error) {
    if (options.signal?.aborted) {
      output.diagnostic(interruptDiagnostic(command));
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
