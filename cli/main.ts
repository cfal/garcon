import packageJson from '../package.json' with { type: 'json' };
import fs from 'node:fs/promises';
import { CLI_HELP, parseCliArgs, type ParsedCliCommand } from './args.js';
import { runCatalogQuery } from './catalog-query.js';
import { resumeChatAsync, stopChat } from './chat-control.js';
import { runAddRow, validateAddRowContent } from './chat-row.js';
import { runChatStatus } from './chat-status.js';
import { runChatExport } from './chat-export.js';
import { runChatHandoff } from './chat-handoff.js';
import { runChatWait } from './chat-wait.js';
import { runConsultation, startConsultationAsync } from './consultation.js';
import { runChatCatalog } from './chat-catalog.js';
import { runChatSearch } from './chat-search.js';
import { runChatRead } from './chat-read.js';
import { runPermissionAnswer, runPermissionDecision } from './chat-permission.js';
import { runChatOrderMutation, runRename, runSetTags } from './chat-metadata.js';
import { runTranscriptSearchAdministration } from './transcript-search.js';
import {
  resumeAsyncJsonEnvelope,
  startAsyncJsonEnvelope,
  stopJsonEnvelope,
  titleUpdateFailure,
} from './automation-output.js';
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

async function readStdin(
  decoder: TextDecoder,
  signal?: AbortSignal,
): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
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
      content += decodeStdin(decoder, value, true);
    }
    signal?.throwIfAborted();
    return content + decodeStdin(decoder, undefined, false);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function readDefaultStdin(signal?: AbortSignal): Promise<string> {
  return readStdin(new TextDecoder(), signal);
}

function readStrictUtf8Stdin(signal?: AbortSignal): Promise<string> {
  return readStdin(new TextDecoder('utf-8', { fatal: true }), signal);
}

function decodeStdin(
  decoder: TextDecoder,
  value: Uint8Array | undefined,
  stream: boolean,
): string {
  try {
    return decoder.decode(value, { stream });
  } catch (error) {
    throw new CliError('arguments', 'stdin must contain valid UTF-8', 2, { cause: error });
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

async function readConfiguredStdin(
  options: MainOptions,
  defaultReader: (signal?: AbortSignal) => Promise<string> = readDefaultStdin,
): Promise<string> {
  return options.readStdin
    ? await readPromptFromStdin(options.readStdin, options.signal)
    : await defaultReader(options.signal);
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
  if (command?.kind === 'add-row') {
    return 'terminal interrupted; the add-row command may have reached Garcon; inspect the chat before retrying';
  }
  if (command?.kind === 'export') {
    return 'terminal interrupted; no transcript export was written';
  }
  if (command?.kind === 'handoff') {
    return 'terminal interrupted; no handoff artifact was written';
  }
  if (command?.kind === 'transcript-search') {
    return command.action === 'status'
      ? 'terminal interrupted; the read-only operation was canceled'
      : 'terminal interrupted; the command may have reached Garcon; inspect transcript-search status before retrying';
  }
  if (
    command !== undefined
    && ['list', 'chats', 'search', 'read', 'status', 'wait', 'lookup-native-session']
      .includes(command.kind)
  ) return 'terminal interrupted; the read-only operation was canceled';
  if (
    command !== undefined
    && [
      'start-async',
      'resume-async',
      'stop',
      'permission-decision',
      'permission-answer',
      'archive',
      'unarchive',
      'pin',
      'unpin',
      'rename',
      'set-tags',
    ].includes(command.kind)
  ) {
    return 'terminal interrupted; the command may have reached Garcon; inspect the chat before retrying';
  }
  return command !== undefined
    ? 'terminal interrupted; no Garcon agent was stopped'
    : 'terminal interrupted; no Garcon command was run';
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
    if (command.kind === 'status') {
      const client = await connectedClient(command, options);
      await runChatStatus(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'chats') {
      const client = await connectedClient(command, options);
      await runChatCatalog(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'search') {
      const client = await connectedClient(command, options);
      await runChatSearch(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'transcript-search') {
      const client = await connectedClient(command, options);
      await runTranscriptSearchAdministration(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'read') {
      const client = await connectedClient(command, options);
      await runChatRead(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'export') {
      const client = await connectedClient(command, options);
      await runChatExport(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'handoff') {
      const client = await connectedClient(command, options);
      await runChatHandoff(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'lookup-native-session') {
      const client = await connectedClient(command, options);
      const chatId = await client.lookupNativeSession({
        nativeSessionId: command.nativeSessionId,
        ...(command.agentId === undefined ? {} : { agent: command.agentId }),
      }, options.signal);
      output.result(chatId);
      return 0;
    }
    if (command.kind === 'permission-decision') {
      const client = await connectedClient(command, options);
      await runPermissionDecision(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'permission-answer') {
      const client = await connectedClient(command, options);
      await runPermissionAnswer(command, client, output, options.signal);
      return 0;
    }
    if (
      command.kind === 'archive'
      || command.kind === 'unarchive'
      || command.kind === 'pin'
      || command.kind === 'unpin'
    ) {
      const client = await connectedClient(command, options);
      await runChatOrderMutation(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'rename') {
      const client = await connectedClient(command, options);
      await runRename(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'set-tags') {
      const client = await connectedClient(command, options);
      await runSetTags(command, client, output, options.signal);
      return 0;
    }
    if (command.kind === 'stop') {
      const client = await connectedClient(command, options);
      const result = await stopChat(command.chatId, client, options.signal);
      if (command.json) {
        output.result(JSON.stringify(stopJsonEnvelope({
          workspace: command.workspace,
          serverInstanceId: client.serverInstanceId,
        }, result), null, 2));
      } else {
        output.stopped(result.response.chatId!, result.response.outcome);
      }
      return 0;
    }
    if (command.kind === 'resume-async') {
      const message = command.readsMessageFromStdin
        ? await readConfiguredStdin(options)
        : command.message ?? '';
      if (message.trim().length === 0) {
        throw new CliError('arguments', 'the message read from stdin must not be empty', 2);
      }
      const client = await connectedClient(command, options);
      const result = await resumeChatAsync({
        chatId: command.chatId,
        content: message,
        allowSteer: command.allowSteer,
        ...(command.userMessagePresentation === undefined
          ? {}
          : { userMessagePresentation: command.userMessagePresentation }),
      }, client, options.signal);
      if (command.json) {
        output.result(JSON.stringify(resumeAsyncJsonEnvelope({
          workspace: command.workspace,
          serverInstanceId: client.serverInstanceId,
        }, result), null, 2));
      } else {
        output.sent(result.response.chatId, result.delivery, result.response.turnId);
      }
      return 0;
    }
    if (command.kind === 'add-row') {
      const content = command.readsContentFromStdin
        ? await readConfiguredStdin(options, readStrictUtf8Stdin)
        : command.content ?? '';
      const validatedContent = validateAddRowContent(content);
      const client = await connectedClient(command, options);
      await runAddRow(command, validatedContent, client, output, options.signal);
      return 0;
    }
    const prompt = command.readsPromptFromStdin
      ? await readConfiguredStdin(options)
      : command.prompt ?? '';
    if (prompt.trim().length === 0) {
      throw new CliError('arguments', 'the prompt read from stdin must not be empty', 2);
    }
    const invocation = command.kind === 'start' || command.kind === 'start-async'
      ? { ...command, cwd: await canonicalProjectDirectory(command.cwd) }
      : command;
    const client = await connectedClient(invocation, options);
    if (invocation.kind === 'start-async') {
      const result = await startConsultationAsync(invocation, prompt, client, options.signal);
      if (invocation.json) {
        output.result(JSON.stringify(startAsyncJsonEnvelope({
          workspace: invocation.workspace,
          serverInstanceId: client.serverInstanceId,
        }, result), null, 2));
      } else {
        output.accepted(result.accepted);
      }
      const titleError = titleUpdateFailure(result);
      if (titleError !== undefined) throw titleError;
    } else {
      await runConsultation(invocation, prompt, client, output, options.signal);
    }
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
