import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  isPermissionMode,
  isThinkingMode,
  PERMISSION_MODE_VALUES,
  THINKING_MODE_VALUES,
  type PermissionMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import { parseChatId, type ChatId } from '@garcon/common/chat-id';
import { isCommandCorrelationIdWithinLimit } from '@garcon/common/chat-command-contracts';
import { normalizeTags, normalizeTagSlug } from '@garcon/common/tags';
import { argumentError } from './errors.js';

export const CLI_HELP = `Usage:
  garcon-cli [options] <prompt>
  garcon-cli [options] --resume <chat-id> <prompt>
  garcon-cli [options] list <resource>
  garcon-cli [options] send-async <chat-id> [--allow-steer] <message>
  garcon-cli [options] stop <chat-id>
  garcon-cli [connection options] wait <chat-id> --turn <turn-id> [--json]

Starts or resumes a visible chat through an already-running Garcon server.
The selected permission mode may allow the agent to edit files and run tools.
send-async submits one turn and returns immediately; it inherits the chat's
saved execution settings, so it may edit files or run tools. Use - as the
message to read UTF-8 text from stdin. stop uses the same command as the SPA
Stop button and interrupts the active turn. If queued messages exist, stop
pauses the queue; resume it in Garcon before sending a new direct turn.

List resources:
  agents
  providers                 Optionally filter with --agent or --provider
  endpoints                 Requires --provider; optionally filter with --agent or --endpoint
  models                    Requires --agent; optionally filter with --provider and --endpoint
  permissions               Requires --agent
  reasoning-efforts         Requires --agent

Options:
  --workspace <name>           Named Garcon data workspace (default: default)
  --config-dir <path>          Garcon config root (default: ~/.garcon)
  --server <url>               Assert the workspace descriptor's exact URL
  --cwd <path>                 Project directory for a new chat (default: current directory)
  --agent <id>                 Agent ID; required for a new chat and agent-scoped lists
  --provider <id>              Configured API provider ID
  --endpoint <id>              Endpoint ID within --provider
  --model <id>                 Model value or raw model; required for a new chat
  --permissions <mode>         Permission mode: ${PERMISSION_MODE_VALUES.join(', ')}
  --reasoning-effort <mode>    Reasoning effort: ${THINKING_MODE_VALUES.join(', ')}
  --title <title>              Set the chat title after the turn is accepted
  --tag <name>                 Add a tag; repeatable. New chats always receive cli
  --resume <chat-id>           Resume an existing chat
  --allow-steer                With send-async, steer the active turn when busy; never queues
  --turn <turn-id>             Exact accepted turn to wait for
  --json                       Print list or wait results as JSON
  --help                       Show this help
  --version                    Show the Garcon version

Use a single - as the prompt to read UTF-8 text from stdin.
Use -- before a positional prompt whose first word is list, send-async, stop, or wait.
The cli tag records creation through garcon-cli; resume, send-async, and stop never add it.`;

export interface CliEnvironment {
  GARCON_CONFIG_DIR?: string;
  GARCON_WORKSPACE?: string;
  HOME?: string;
}

interface CliSelectionOptions {
  agentId?: string;
  providerId?: string;
  endpointId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
}

export interface CliConnectionOptions {
  workspace: string;
  configDir: string;
  serverUrl?: string;
}

interface CliInvocationBase extends CliSelectionOptions, CliConnectionOptions {
  kind: 'start' | 'resume';
  title?: string;
  additionalTags?: string[];
  prompt: string | null;
  readsPromptFromStdin: boolean;
}

export interface StartCliInvocation extends CliInvocationBase {
  kind: 'start';
  agentId: string;
  model: string;
  cwd: string;
}

export interface ResumeCliInvocation extends CliInvocationBase {
  kind: 'resume';
  chatId: ChatId;
}

export type CliInvocation = StartCliInvocation | ResumeCliInvocation;

export const LIST_RESOURCE_VALUES = [
  'agents',
  'providers',
  'endpoints',
  'models',
  'permissions',
  'reasoning-efforts',
] as const;

export type ListResource = (typeof LIST_RESOURCE_VALUES)[number];

export interface ListCliCommand extends CliConnectionOptions {
  kind: 'list';
  resource: ListResource;
  json: boolean;
  agentId?: string;
  providerId?: string;
  endpointId?: string;
}

export interface SendAsyncCliCommand extends CliConnectionOptions {
  kind: 'send-async';
  chatId: ChatId;
  allowSteer: boolean;
  message: string | null;
  readsMessageFromStdin: boolean;
}

export interface StopCliCommand extends CliConnectionOptions {
  kind: 'stop';
  chatId: ChatId;
}

export interface WaitCliCommand extends CliConnectionOptions {
  kind: 'wait';
  chatId: ChatId;
  turnId: string;
  json: boolean;
}

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | ListCliCommand
  | SendAsyncCliCommand
  | StopCliCommand
  | WaitCliCommand
  | CliInvocation;

const SINGLE_STRING_OPTIONS = [
  'workspace',
  'config-dir',
  'server',
  'cwd',
  'agent',
  'provider',
  'endpoint',
  'model',
  'permissions',
  'reasoning-effort',
  'title',
  'resume',
  'turn',
] as const;

type ParsedOptionValue = boolean | string | string[] | undefined;

function nonEmptyOption(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw argumentError(`${flag} must not be empty`);
  return value;
}

function resolvedEnvironmentValue(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function validateWorkspace(value: string): string {
  if (value.trim().length === 0) throw argumentError('--workspace must not be empty');
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw argumentError('--workspace must be a name without path separators');
  }
  return value;
}

function parseModeOptions(values: Record<string, ParsedOptionValue>): {
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
} {
  const permission = values.permissions as string | undefined;
  if (permission !== undefined && !isPermissionMode(permission)) {
    throw argumentError(`--permissions must be one of: ${PERMISSION_MODE_VALUES.join(', ')}`);
  }
  const thinking = values['reasoning-effort'] as string | undefined;
  if (thinking !== undefined && !isThinkingMode(thinking)) {
    throw argumentError(`--reasoning-effort must be one of: ${THINKING_MODE_VALUES.join(', ')}`);
  }
  return {
    ...(permission === undefined ? {} : { permissionMode: permission }),
    ...(thinking === undefined ? {} : { thinkingMode: thinking }),
  };
}

function parseAdditionalTags(value: ParsedOptionValue): string[] | undefined {
  if (value === undefined) return undefined;
  const rawTags = value as string[];
  for (const tag of rawTags) {
    if (!normalizeTagSlug(tag)) throw argumentError('--tag must contain letters or numbers');
  }
  const tags = normalizeTags(rawTags).filter((tag) => tag !== 'cli');
  return tags.length > 0 ? tags : undefined;
}

function isListResource(value: string): value is ListResource {
  return (LIST_RESOURCE_VALUES as readonly string[]).includes(value);
}

function rejectListOption(value: unknown, flag: string): void {
  if (value !== undefined) throw argumentError(`${flag} cannot be used with list`);
}

// Reserved subcommands are recognized only when the first positional token appears
// before an option terminator, so `-- send-async ...` remains a new-chat prompt.
function startsReservedCommand(
  tokens: NonNullable<ReturnType<typeof parseArgs>['tokens']>,
  name: string,
): boolean {
  const positional = tokens.find((token) => token.kind === 'positional');
  if (positional?.value !== name) return false;
  const terminator = tokens.find((token) => token.kind === 'option-terminator');
  return terminator === undefined || positional.index < terminator.index;
}

type ControlCommandKind = 'send-async' | 'stop';

const CONTROL_FORBIDDEN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['cwd', '--cwd'],
  ['agent', '--agent'],
  ['provider', '--provider'],
  ['endpoint', '--endpoint'],
  ['model', '--model'],
  ['permissions', '--permissions'],
  ['reasoning-effort', '--reasoning-effort'],
  ['title', '--title'],
  ['tag', '--tag'],
  ['resume', '--resume'],
  ['json', '--json'],
  ['turn', '--turn'],
] as const;

function rejectControlForbiddenOptions(
  values: Record<string, ParsedOptionValue>,
  command: ControlCommandKind,
): void {
  for (const [key, flag] of CONTROL_FORBIDDEN_OPTIONS) {
    if (values[key] !== undefined) throw argumentError(`${flag} cannot be used with ${command}`);
  }
}

function parseControlChatId(value: string, command: ControlCommandKind): ChatId {
  try {
    return parseChatId(value);
  } catch (error) {
    throw argumentError(`${command} requires a valid Garcon chat ID`, { cause: error });
  }
}

function parseSendAsync(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): SendAsyncCliCommand {
  rejectControlForbiddenOptions(values, 'send-async');
  if (parsed.positionals.length !== 3) {
    throw argumentError('send-async requires a chat ID and one message');
  }
  const chatId = parseControlChatId(parsed.positionals[1]!, 'send-async');
  const messageArgument = parsed.positionals[2]!;
  const readsMessageFromStdin = messageArgument === '-';
  const message = readsMessageFromStdin ? null : messageArgument;
  if (message !== null && message.trim().length === 0) {
    throw argumentError('the message must not be empty');
  }
  return {
    kind: 'send-async',
    ...connection,
    chatId,
    allowSteer: values['allow-steer'] === true,
    message,
    readsMessageFromStdin,
  };
}

function parseStop(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): StopCliCommand {
  rejectControlForbiddenOptions(values, 'stop');
  if (values['allow-steer'] !== undefined) {
    throw argumentError('--allow-steer cannot be used with stop');
  }
  if (parsed.positionals.length !== 2) {
    throw argumentError('stop requires exactly one chat ID');
  }
  return {
    kind: 'stop',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'stop'),
  };
}

const WAIT_FORBIDDEN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['cwd', '--cwd'],
  ['agent', '--agent'],
  ['provider', '--provider'],
  ['endpoint', '--endpoint'],
  ['model', '--model'],
  ['permissions', '--permissions'],
  ['reasoning-effort', '--reasoning-effort'],
  ['title', '--title'],
  ['tag', '--tag'],
  ['resume', '--resume'],
  ['allow-steer', '--allow-steer'],
] as const;

function parseWait(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): WaitCliCommand {
  for (const [key, flag] of WAIT_FORBIDDEN_OPTIONS) {
    if (values[key] !== undefined) throw argumentError(`${flag} cannot be used with wait`);
  }
  if (parsed.positionals.length !== 2) {
    throw argumentError('wait requires exactly one chat ID');
  }
  let chatId: ChatId;
  try {
    chatId = parseChatId(parsed.positionals[1]!);
  } catch (error) {
    throw argumentError('wait requires a valid Garcon chat ID', { cause: error });
  }
  const rawTurnId = values.turn;
  const turnId = typeof rawTurnId === 'string' ? rawTurnId : '';
  if (
    turnId.length === 0
    || turnId.trim() !== turnId
    || !isCommandCorrelationIdWithinLimit(turnId)
  ) {
    throw argumentError('wait requires one valid --turn ID');
  }
  return {
    kind: 'wait',
    ...connection,
    chatId,
    turnId,
    json: values.json === true,
  };
}

export function parseCliArgs(
  argv: readonly string[],
  environment: CliEnvironment = process.env as CliEnvironment,
  currentDirectory = process.cwd(),
): ParsedCliCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        workspace: { type: 'string' },
        'config-dir': { type: 'string' },
        server: { type: 'string' },
        cwd: { type: 'string' },
        agent: { type: 'string' },
        provider: { type: 'string' },
        endpoint: { type: 'string' },
        model: { type: 'string' },
        permissions: { type: 'string' },
        'reasoning-effort': { type: 'string' },
        title: { type: 'string' },
        tag: { type: 'string', multiple: true },
        resume: { type: 'string' },
        turn: { type: 'string' },
        'allow-steer': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
      tokens: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw argumentError(message, { cause: error });
  }

  const repeated = new Set<string>();
  const observed = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (
      token.kind !== 'option'
      || !SINGLE_STRING_OPTIONS.includes(token.name as typeof SINGLE_STRING_OPTIONS[number])
    ) {
      continue;
    }
    if (observed.has(token.name)) repeated.add(token.name);
    observed.add(token.name);
  }
  if (repeated.size > 0) {
    throw argumentError(`option may be specified only once: --${[...repeated][0]}`);
  }

  const values = parsed.values as Record<string, ParsedOptionValue>;
  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const explicitConfigDir = nonEmptyOption(values['config-dir'] as string | undefined, '--config-dir');
  const environmentConfigDir = resolvedEnvironmentValue(environment.GARCON_CONFIG_DIR);
  const configDir = path.resolve(
    environmentConfigDir
      ?? explicitConfigDir
      ?? path.join(environment.HOME ?? os.homedir(), '.garcon'),
  );
  const explicitWorkspace = nonEmptyOption(values.workspace as string | undefined, '--workspace');
  const workspace = validateWorkspace(
    resolvedEnvironmentValue(environment.GARCON_WORKSPACE) ?? explicitWorkspace ?? 'default',
  );
  const serverUrl = nonEmptyOption(values.server as string | undefined, '--server');
  const agentId = nonEmptyOption(values.agent as string | undefined, '--agent');
  const providerId = nonEmptyOption(values.provider as string | undefined, '--provider');
  const endpointId = nonEmptyOption(values.endpoint as string | undefined, '--endpoint');
  const model = nonEmptyOption(values.model as string | undefined, '--model');
  const cwd = nonEmptyOption(values.cwd as string | undefined, '--cwd');
  const resume = nonEmptyOption(values.resume as string | undefined, '--resume');
  const title = nonEmptyOption(values.title as string | undefined, '--title')?.trim();
  const additionalTags = parseAdditionalTags(values.tag);
  const tokens = parsed.tokens ?? [];
  const connection = {
    workspace,
    configDir,
    ...(serverUrl === undefined ? {} : { serverUrl }),
  };

  if (startsReservedCommand(tokens, 'send-async')) {
    return parseSendAsync(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'stop')) {
    return parseStop(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'wait')) {
    return parseWait(parsed, values, connection);
  }

  if (startsReservedCommand(tokens, 'list')) {
    const resource = parsed.positionals[1] ?? '';
    if (parsed.positionals.length !== 2 || !isListResource(resource)) {
      throw argumentError(`list requires one resource: ${LIST_RESOURCE_VALUES.join(', ')}`);
    }
    rejectListOption(cwd, '--cwd');
    rejectListOption(values.model, '--model');
    rejectListOption(values.permissions, '--permissions');
    rejectListOption(values['reasoning-effort'], '--reasoning-effort');
    rejectListOption(values.title, '--title');
    rejectListOption(values.tag, '--tag');
    rejectListOption(resume, '--resume');
    rejectListOption(values['allow-steer'], '--allow-steer');
    rejectListOption(values.turn, '--turn');
    if (endpointId !== undefined && providerId === undefined) {
      throw argumentError('--endpoint requires --provider');
    }
    if (resource === 'agents') {
      rejectListOption(agentId, '--agent');
      rejectListOption(providerId, '--provider');
      rejectListOption(endpointId, '--endpoint');
    }
    if (resource === 'providers') rejectListOption(endpointId, '--endpoint');
    if (resource === 'endpoints' && providerId === undefined) {
      throw argumentError('list endpoints requires --provider');
    }
    if (
      (resource === 'models' || resource === 'permissions' || resource === 'reasoning-efforts')
      && agentId === undefined
    ) {
      throw argumentError(`list ${resource} requires --agent`);
    }
    if (resource === 'permissions' || resource === 'reasoning-efforts') {
      rejectListOption(providerId, '--provider');
      rejectListOption(endpointId, '--endpoint');
    }
    return {
      kind: 'list',
      resource,
      workspace,
      configDir,
      json: values.json === true,
      ...(serverUrl === undefined ? {} : { serverUrl }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(endpointId === undefined ? {} : { endpointId }),
    };
  }

  if (values.json !== undefined) throw argumentError('--json can only be used with list or wait');
  if (values.turn !== undefined) throw argumentError('--turn can only be used with wait');
  if (values['allow-steer'] !== undefined) {
    throw argumentError('--allow-steer can only be used with send-async');
  }
  const modes = parseModeOptions(values);

  if (endpointId !== undefined && providerId === undefined) {
    throw argumentError('--endpoint requires --provider');
  }
  if (resume !== undefined && (providerId !== undefined || endpointId !== undefined) && model === undefined) {
    throw argumentError('--provider and --endpoint require --model when resuming');
  }

  if (parsed.positionals.length === 0) throw argumentError('a prompt is required');
  const readsPromptFromStdin = parsed.positionals.length === 1 && parsed.positionals[0] === '-';
  if (!readsPromptFromStdin && parsed.positionals.includes('-')) {
    throw argumentError('stdin marker - must be the only prompt argument');
  }
  const prompt = readsPromptFromStdin ? null : parsed.positionals.join(' ');
  if (prompt !== null && prompt.trim().length === 0) throw argumentError('the prompt must not be empty');

  const shared = {
    workspace,
    configDir,
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(model === undefined ? {} : { model }),
    ...(title === undefined ? {} : { title }),
    ...(additionalTags === undefined ? {} : { additionalTags }),
    ...modes,
    prompt,
    readsPromptFromStdin,
  };

  if (resume !== undefined) {
    if (cwd !== undefined) throw argumentError('--cwd cannot be used with --resume');
    let chatId: ChatId;
    try {
      chatId = parseChatId(resume);
    } catch (error) {
      throw argumentError('--resume must be a valid Garcon chat ID', { cause: error });
    }
    return { kind: 'resume', ...shared, chatId };
  }

  if (agentId === undefined) throw argumentError('--agent is required for a new chat');
  if (model === undefined) throw argumentError('--model is required for a new chat');
  return {
    kind: 'start',
    ...shared,
    agentId,
    model,
    cwd: path.resolve(currentDirectory, cwd ?? '.'),
  };
}
