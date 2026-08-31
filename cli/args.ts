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
import {
  parseChatRowTitle,
} from '@garcon/common/chat-row-contracts';
import {
  CLI_PRESET_PRESENTATION_STYLES,
  CLI_PRESENTATION_STYLE_LIST,
  isCliPresentationStyle,
  normalizeCliHexColor,
  type CliCustomStyle,
  type CliBodyDisclosure,
  type CliPresentation,
  type CliRowFormat,
} from '@garcon/common/cli-presentation';
import { isCommandCorrelationIdWithinLimit } from '@garcon/common/chat-command-contracts';
import type { UserMessagePresentation } from '@garcon/common/chat-types';
import {
  CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT,
  CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT,
} from '@garcon/common/chat-snapshot';
import { normalizeTags, normalizeTagSlug } from '@garcon/common/tags';
import {
  TRANSCRIPT_EXPORT_CATEGORIES,
  TRANSCRIPT_EXPORT_CATEGORY_ALIASES,
  canonicalTranscriptExportCategories,
  isTranscriptExportCategory,
  isTranscriptExportFormat,
  type TranscriptExportCategory,
  type TranscriptExportFormat,
} from '@garcon/common/chat-export-contracts';
import {
  DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
  HANDOFF_CONTEXT_WINDOW_MAX_TOKENS,
  HANDOFF_CONTEXT_WINDOW_MIN_TOKENS,
  isHandoffContextWindowTokens,
} from '@garcon/common/handoff-sizing';
import { argumentError } from './errors.js';

const ADD_ROW_PRESENTATION_REQUIREMENT = [
  ...CLI_PRESET_PRESENTATION_STYLES.map((style) => `--type ${style}`),
  '--color',
].join(' or ');

export const CLI_HELP = `Usage:
  garcon-cli [options] [--parent <chat-id>] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>
  garcon-cli [options] --resume <chat-id> [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>
  garcon-cli [options] list <resource>
  garcon-cli [options] send-async <chat-id> [--allow-steer] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <message>
  garcon-cli [options] stop <chat-id>
  garcon-cli [connection options] add-row <chat-id> (--type <info|notice|error> | --color <light[,dark]>) [--title <title>] [--markdown] [--collapsible] <content>
  garcon-cli [connection options] status <chat-id> [--messages <count>] [--json]
  garcon-cli [connection options] wait <chat-id> --turn <turn-id> [--json]
  garcon-cli [connection options] export <chat-id> [--format <markdown|xml>] [--exclude <category>]... [--output <path>] [--force]
  garcon-cli [connection options] handoff <chat-id> [--context-window-size <tokens>] [--output <path>] [--force]

Starts or resumes a visible chat through an already-running Garcon server.
The selected permission mode may allow the agent to edit files and run tools.
send-async submits one turn and returns immediately; it inherits the chat's
saved execution settings, so it may edit files or run tools. Use - as the
message to read UTF-8 text from stdin. stop uses the same command as the SPA
Stop button and interrupts the active turn. If queued messages exist, stop
pauses the queue; resume it in Garcon before sending a new direct turn.
add-row appends one durable presentation-only CLI row to chat history.
It never sends, queues, or exposes the row to the agent.
export writes the complete untruncated transcript as Markdown or XML. Exclusions
apply to top-level entries; tool calls embedded in permission entries remain.
handoff creates a read-only XML projection for another model to summarize. It
creates no chat, changes no agent or owner, starts no run, and appends nothing.
Message presentation is not sent as prompt text. A message title without a style
uses notice; a style without a title displays its CLI label. --color selects custom styling.
--collapsible starts the CLI-authored body collapsed without requiring a style.
Ordinary restart, replay, shares, and frozen forks preserve it. Native-history
Reload and provider-native fork segments may drop Garcon-only presentation.

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
  --parent <chat-id>           Record an existing parent for a new delegated chat
  --agent <id>                 Agent ID; required for a new chat and agent-scoped lists
  --provider <id>              Configured API provider ID
  --endpoint <id>              Endpoint ID within --provider
  --model <id>                 Model value or raw model; required for a new chat
  --permissions <mode>         Permission mode: ${PERMISSION_MODE_VALUES.join(', ')}
  --reasoning-effort <mode>    Reasoning effort: ${THINKING_MODE_VALUES.join(', ')}
  --title <title>              Set a new-chat title or add-row heading
  --message-title <title>      Add a heading to this conversational CLI user message
  --message-style <style>      Style this CLI user message: info, notice, error, or custom
  --color <light[,dark]>       Custom six-digit hex accent; one value applies to both themes
  --tag <name>                 Add a tag; repeatable. New chats always receive cli
  --resume <chat-id>           Resume an existing chat
  --allow-steer                With send-async, steer the active turn when busy; never queues
  --messages <count>           Status transcript entries, 0-${CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT} (default: ${CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT})
  --turn <turn-id>             Exact accepted turn to wait for
  --type <style>               Add-row style: info, notice, error, or custom
  --markdown                   Render add-row content as Markdown
  --collapsible                Start this CLI-authored content collapsed
  --format <markdown|xml>      Transcript export format (default: markdown)
  --exclude <category>         Export exclusion; repeatable or comma-separated:
                               ${TRANSCRIPT_EXPORT_CATEGORIES.join(', ')}; tools excludes calls and results
  --context-window-size <tokens>
                               Context window of the model that will read the
                               handoff artifact (default: ${DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS}). Garcon limits
                               the artifact to 75% of this token capacity using
                               an estimate; token usage varies by model.
  --output <path>              Write export or handoff artifact atomically to a file
  --force                      Replace an existing export or handoff output file
  --json                       Print list, status, or wait results as JSON
  --help                       Show this help
  --version                    Show the Garcon version

Use a single - as the prompt to read UTF-8 text from stdin.
Use -- before a positional prompt whose first word is list, send-async, stop, add-row, status, wait, export, or handoff.
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
  userMessagePresentation?: UserMessagePresentation;
}

export interface StartCliInvocation extends CliInvocationBase {
  kind: 'start';
  agentId: string;
  model: string;
  cwd: string;
  parentChatId?: ChatId;
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
  userMessagePresentation?: UserMessagePresentation;
}

export interface StopCliCommand extends CliConnectionOptions {
  kind: 'stop';
  chatId: ChatId;
}

export interface AddRowCliCommand extends CliConnectionOptions {
  readonly kind: 'add-row';
  readonly chatId: ChatId;
  readonly presentation: CliPresentation;
  readonly format: CliRowFormat;
  readonly disclosure: CliBodyDisclosure;
  readonly title?: string;
  readonly content: string | null;
  readonly readsContentFromStdin: boolean;
}

export interface WaitCliCommand extends CliConnectionOptions {
  kind: 'wait';
  chatId: ChatId;
  turnId: string;
  json: boolean;
}

export interface StatusCliCommand extends CliConnectionOptions {
  kind: 'status';
  chatId: ChatId;
  messageLimit: number;
  json: boolean;
}

export interface ExportCliCommand extends CliConnectionOptions {
  readonly kind: 'export';
  readonly chatId: ChatId;
  readonly format: TranscriptExportFormat;
  readonly exclusions: readonly TranscriptExportCategory[];
  readonly outputPath?: string;
  readonly force: boolean;
}

export interface HandoffCliCommand extends CliConnectionOptions {
  readonly kind: 'handoff';
  readonly chatId: ChatId;
  readonly contextWindowTokens: number;
  readonly outputPath?: string;
  readonly force: boolean;
}

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | ListCliCommand
  | SendAsyncCliCommand
  | StopCliCommand
  | AddRowCliCommand
  | StatusCliCommand
  | WaitCliCommand
  | ExportCliCommand
  | HandoffCliCommand
  | CliInvocation;

const SINGLE_STRING_OPTIONS = [
  'workspace',
  'config-dir',
  'server',
  'cwd',
  'parent',
  'agent',
  'provider',
  'endpoint',
  'model',
  'permissions',
  'reasoning-effort',
  'title',
  'message-title',
  'message-style',
  'color',
  'resume',
  'turn',
  'messages',
  'type',
  'format',
  'output',
  'context-window-size',
] as const;

type ParsedOptionValue = boolean | string | string[] | undefined;

function nonEmptyOption(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw argumentError(`${flag} must not be empty`);
  return value;
}

function parseChatIdOption(value: string, flag: string): ChatId {
  try {
    return parseChatId(value);
  } catch (error) {
    throw argumentError(`${flag} must be a valid Garcon chat ID`, { cause: error });
  }
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

function parseUserMessagePresentationOptions(
  values: Record<string, ParsedOptionValue>,
): UserMessagePresentation | undefined {
  const rawStyle = values['message-style'];
  if (rawStyle !== undefined && !isCliPresentationStyle(rawStyle)) {
    throw argumentError(`--message-style must be one of: ${CLI_PRESENTATION_STYLE_LIST}`);
  }
  const customStyle = parseCliColorOption(values.color);
  const collapsible = values.collapsible === true;
  if (customStyle && rawStyle !== undefined && rawStyle !== 'custom') {
    throw argumentError('--color cannot be combined with a preset --message-style');
  }
  let title: string | undefined;
  try {
    title = parseChatRowTitle(values['message-title']);
  } catch (error) {
    throw argumentError(error instanceof Error ? error.message : 'message title is invalid', {
      cause: error,
    });
  }
  if (rawStyle === undefined && title === undefined && !customStyle && !collapsible) return undefined;
  if (rawStyle === undefined && title === undefined && !customStyle) {
    return { origin: 'cli', disclosure: 'collapsed' };
  }
  let presentation: CliPresentation;
  if (customStyle) {
    presentation = { style: 'custom', customStyle };
  } else {
    if (rawStyle === 'custom') {
      throw argumentError('--message-style custom requires --color');
    }
    presentation = { style: rawStyle ?? 'notice' };
  }
  return {
    origin: 'cli',
    ...presentation,
    ...(title === undefined ? {} : { title }),
    ...(collapsible ? { disclosure: 'collapsed' as const } : {}),
  };
}

function parseCliColorOption(value: ParsedOptionValue): CliCustomStyle | undefined {
  if (value === undefined) return undefined;
  const parts = (value as string).split(',');
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw argumentError('--color must be one or two six-digit hex colors separated by a comma');
  }
  const lightAccent = normalizeCliHexColor(parts[0]!);
  const darkAccent = normalizeCliHexColor(parts[1] ?? parts[0]!);
  if (!lightAccent || !darkAccent) {
    throw argumentError('--color must be one or two six-digit hex colors separated by a comma');
  }
  return { lightAccent, darkAccent };
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

type ControlCommandKind = 'send-async' | 'stop' | 'add-row';

const CONTROL_FORBIDDEN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['cwd', '--cwd'],
  ['parent', '--parent'],
  ['agent', '--agent'],
  ['provider', '--provider'],
  ['endpoint', '--endpoint'],
  ['model', '--model'],
  ['permissions', '--permissions'],
  ['reasoning-effort', '--reasoning-effort'],
  ['tag', '--tag'],
  ['resume', '--resume'],
  ['json', '--json'],
  ['turn', '--turn'],
  ['messages', '--messages'],
  ['format', '--format'],
  ['exclude', '--exclude'],
  ['output', '--output'],
  ['force', '--force'],
  ['context-window-size', '--context-window-size'],
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
  if (values.title !== undefined) throw argumentError('--title cannot be used with send-async');
  if (values.type !== undefined) throw argumentError('--type cannot be used with send-async');
  if (values.markdown !== undefined) throw argumentError('--markdown cannot be used with send-async');
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
  const userMessagePresentation = parseUserMessagePresentationOptions(values);
  return {
    kind: 'send-async',
    ...connection,
    chatId,
    allowSteer: values['allow-steer'] === true,
    message,
    readsMessageFromStdin,
    ...(userMessagePresentation === undefined ? {} : { userMessagePresentation }),
  };
}

function parseStop(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): StopCliCommand {
  rejectControlForbiddenOptions(values, 'stop');
  if (values.title !== undefined) throw argumentError('--title cannot be used with stop');
  if (values['allow-steer'] !== undefined) {
    throw argumentError('--allow-steer cannot be used with stop');
  }
  if (values.type !== undefined) throw argumentError('--type cannot be used with stop');
  if (
    values['message-title'] !== undefined
    || values['message-style'] !== undefined
    || values.color !== undefined
    || values.collapsible !== undefined
  ) {
    throw argumentError('message presentation cannot be used with stop');
  }
  if (values.markdown !== undefined) throw argumentError('--markdown cannot be used with stop');
  if (parsed.positionals.length !== 2) {
    throw argumentError('stop requires exactly one chat ID');
  }
  return {
    kind: 'stop',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'stop'),
  };
}

function parseAddRow(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): AddRowCliCommand {
  rejectControlForbiddenOptions(values, 'add-row');
  if (values['allow-steer'] !== undefined) {
    throw argumentError('--allow-steer cannot be used with add-row');
  }
  if (values['message-title'] !== undefined || values['message-style'] !== undefined) {
    throw argumentError('message presentation cannot be used with add-row');
  }
  if (parsed.positionals.length !== 3) {
    throw argumentError('add-row requires a chat ID and one content argument');
  }
  if (values.type !== undefined && !isCliPresentationStyle(values.type)) {
    throw argumentError(`add-row requires ${ADD_ROW_PRESENTATION_REQUIREMENT}`);
  }
  const customStyle = parseCliColorOption(values.color);
  if (customStyle && values.type !== undefined && values.type !== 'custom') {
    throw argumentError('--color cannot be combined with a preset --type');
  }
  let presentation: CliPresentation;
  if (customStyle) {
    presentation = { style: 'custom', customStyle };
  } else {
    if (values.type === 'custom') {
      throw argumentError('--type custom requires --color');
    }
    if (values.type === undefined) {
      throw argumentError(`add-row requires ${ADD_ROW_PRESENTATION_REQUIREMENT}`);
    }
    presentation = { style: values.type };
  }
  let title: string | undefined;
  try {
    title = parseChatRowTitle(values.title);
  } catch (error) {
    throw argumentError(error instanceof Error ? error.message : 'title is invalid', {
      cause: error,
    });
  }
  const argument = parsed.positionals[2]!;
  const readsContentFromStdin = argument === '-';
  if (!readsContentFromStdin && argument.trim().length === 0) {
    throw argumentError('the row content must not be empty');
  }
  return {
    kind: 'add-row',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'add-row'),
    presentation,
    format: values.markdown === true ? 'markdown' : 'plain',
    disclosure: values.collapsible === true ? 'collapsed' : 'expanded',
    ...(title === undefined ? {} : { title }),
    content: readsContentFromStdin ? null : argument,
    readsContentFromStdin,
  };
}

type ObservationCommandKind = 'status' | 'wait' | 'export' | 'handoff';

const OBSERVATION_FORBIDDEN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['cwd', '--cwd'],
  ['parent', '--parent'],
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
  ['type', '--type'],
  ['message-title', '--message-title'],
  ['message-style', '--message-style'],
  ['color', '--color'],
  ['collapsible', '--collapsible'],
  ['markdown', '--markdown'],
] as const;

function rejectObservationMutationOptions(
  values: Record<string, ParsedOptionValue>,
  command: ObservationCommandKind,
): void {
  for (const [key, flag] of OBSERVATION_FORBIDDEN_OPTIONS) {
    if (values[key] !== undefined) throw argumentError(`${flag} cannot be used with ${command}`);
  }
}

function parseWait(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): WaitCliCommand {
  rejectObservationMutationOptions(values, 'wait');
  rejectDocumentOptions(values, 'wait');
  if (values.messages !== undefined) {
    throw argumentError('--messages cannot be used with wait');
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

function parseStatusMessageLimit(value: ParsedOptionValue): number {
  if (value === undefined) return CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT;
  const raw = value as string;
  if (!/^\d+$/.test(raw)) {
    throw argumentError(
      `--messages must be an integer from 0 through ${CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT) {
    throw argumentError(
      `--messages must be an integer from 0 through ${CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT}`,
    );
  }
  return parsed;
}

function parseStatus(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): StatusCliCommand {
  rejectObservationMutationOptions(values, 'status');
  rejectDocumentOptions(values, 'status');
  if (values.turn !== undefined) throw argumentError('--turn cannot be used with status');
  if (parsed.positionals.length !== 2) {
    throw argumentError('status requires exactly one chat ID');
  }
  let chatId: ChatId;
  try {
    chatId = parseChatId(parsed.positionals[1]!);
  } catch (error) {
    throw argumentError('status requires a valid Garcon chat ID', { cause: error });
  }
  return {
    kind: 'status',
    ...connection,
    chatId,
    messageLimit: parseStatusMessageLimit(values.messages),
    json: values.json === true,
  };
}

function rejectDocumentOptions(
  values: Record<string, ParsedOptionValue>,
  command: Exclude<ObservationCommandKind, 'export' | 'handoff'>,
): void {
  for (const [key, flag] of [
    ['format', '--format'],
    ['exclude', '--exclude'],
    ['output', '--output'],
    ['force', '--force'],
    ['context-window-size', '--context-window-size'],
  ] as const) {
    if (values[key] !== undefined) throw argumentError(`${flag} cannot be used with ${command}`);
  }
}

function parseExport(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ExportCliCommand {
  rejectObservationMutationOptions(values, 'export');
  if (values['context-window-size'] !== undefined) {
    throw argumentError('--context-window-size cannot be used with export');
  }
  if (values.json !== undefined) throw argumentError('--json cannot be used with export');
  if (values.turn !== undefined) throw argumentError('--turn cannot be used with export');
  if (values.messages !== undefined) throw argumentError('--messages cannot be used with export');
  if (parsed.positionals.length !== 2) {
    throw argumentError('export requires exactly one chat ID');
  }
  let chatId: ChatId;
  try {
    chatId = parseChatId(parsed.positionals[1]!);
  } catch (error) {
    throw argumentError('export requires a valid Garcon chat ID', { cause: error });
  }
  const rawFormat = values.format ?? 'markdown';
  if (!isTranscriptExportFormat(rawFormat)) {
    throw argumentError('--format must be markdown or xml');
  }
  const output = parseDocumentOutputOptions(values, 'transcript export');
  return {
    kind: 'export',
    ...connection,
    chatId,
    format: rawFormat,
    exclusions: parseExportExclusions(values.exclude),
    ...output,
  };
}

function parseHandoff(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): HandoffCliCommand {
  rejectObservationMutationOptions(values, 'handoff');
  if (values.json !== undefined) throw argumentError('--json cannot be used with handoff');
  if (values.turn !== undefined) throw argumentError('--turn cannot be used with handoff');
  if (values.messages !== undefined) throw argumentError('--messages cannot be used with handoff');
  if (values.format !== undefined) throw argumentError('--format cannot be used with handoff');
  if (values.exclude !== undefined) throw argumentError('--exclude cannot be used with handoff');
  if (parsed.positionals.length !== 2) {
    throw argumentError('handoff requires exactly one chat ID');
  }
  let chatId: ChatId;
  try {
    chatId = parseChatId(parsed.positionals[1]!);
  } catch (error) {
    throw argumentError('handoff requires a valid Garcon chat ID', { cause: error });
  }
  return {
    kind: 'handoff',
    ...connection,
    chatId,
    contextWindowTokens: parseContextWindowSize(values['context-window-size']),
    ...parseDocumentOutputOptions(values, 'handoff artifact'),
  };
}

function parseContextWindowSize(value: ParsedOptionValue): number {
  if (value === undefined) return DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS;
  const raw = value as string;
  if (!/^[0-9]+$/.test(raw)) {
    throw argumentError('--context-window-size must be a base-10 integer token count');
  }
  const parsed = Number(raw);
  if (!isHandoffContextWindowTokens(parsed)) {
    throw argumentError(
      `--context-window-size must be between ${HANDOFF_CONTEXT_WINDOW_MIN_TOKENS} and ${HANDOFF_CONTEXT_WINDOW_MAX_TOKENS} tokens`,
    );
  }
  return parsed;
}

function parseDocumentOutputOptions(
  values: Record<string, ParsedOptionValue>,
  noun: string,
): Pick<ExportCliCommand, 'outputPath' | 'force'> {
  const outputPath = nonEmptyOption(values.output as string | undefined, '--output');
  if (outputPath === '-') {
    throw argumentError(`omit --output to write the ${noun} to stdout`);
  }
  const force = values.force === true;
  if (force && outputPath === undefined) throw argumentError('--force requires --output');
  return {
    ...(outputPath === undefined ? {} : { outputPath }),
    force,
  };
}

function parseExportExclusions(value: ParsedOptionValue): TranscriptExportCategory[] {
  if (value === undefined) return [];
  const selected: TranscriptExportCategory[] = [];
  for (const option of value as string[]) {
    for (const rawToken of option.split(',')) {
      const token = rawToken.trim();
      if (token.length === 0) throw argumentError('--exclude must not contain an empty category');
      if (Object.hasOwn(TRANSCRIPT_EXPORT_CATEGORY_ALIASES, token)) {
        selected.push(...TRANSCRIPT_EXPORT_CATEGORY_ALIASES[
          token as keyof typeof TRANSCRIPT_EXPORT_CATEGORY_ALIASES
        ]);
      } else if (isTranscriptExportCategory(token)) {
        selected.push(token);
      } else {
        throw argumentError(
          `--exclude must be one of: ${TRANSCRIPT_EXPORT_CATEGORIES.join(', ')}, tools`,
        );
      }
    }
  }
  return canonicalTranscriptExportCategories(selected);
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
        parent: { type: 'string' },
        agent: { type: 'string' },
        provider: { type: 'string' },
        endpoint: { type: 'string' },
        model: { type: 'string' },
        permissions: { type: 'string' },
        'reasoning-effort': { type: 'string' },
        title: { type: 'string' },
        'message-title': { type: 'string' },
        'message-style': { type: 'string' },
        color: { type: 'string' },
        tag: { type: 'string', multiple: true },
        resume: { type: 'string' },
        turn: { type: 'string' },
        messages: { type: 'string' },
        type: { type: 'string' },
        format: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        output: { type: 'string' },
        'context-window-size': { type: 'string' },
        force: { type: 'boolean' },
        'allow-steer': { type: 'boolean' },
        markdown: { type: 'boolean' },
        collapsible: { type: 'boolean' },
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
  const parent = nonEmptyOption(values.parent as string | undefined, '--parent');
  const resume = nonEmptyOption(values.resume as string | undefined, '--resume');
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
  if (startsReservedCommand(tokens, 'add-row')) {
    return parseAddRow(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'wait')) {
    return parseWait(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'status')) {
    return parseStatus(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'export')) {
    return parseExport(parsed, values, connection);
  }
  if (startsReservedCommand(tokens, 'handoff')) {
    return parseHandoff(parsed, values, connection);
  }

  if (startsReservedCommand(tokens, 'list')) {
    const resource = parsed.positionals[1] ?? '';
    if (parsed.positionals.length !== 2 || !isListResource(resource)) {
      throw argumentError(`list requires one resource: ${LIST_RESOURCE_VALUES.join(', ')}`);
    }
    rejectListOption(cwd, '--cwd');
    rejectListOption(parent, '--parent');
    rejectListOption(values.model, '--model');
    rejectListOption(values.permissions, '--permissions');
    rejectListOption(values['reasoning-effort'], '--reasoning-effort');
    rejectListOption(values.title, '--title');
    rejectListOption(values.tag, '--tag');
    rejectListOption(resume, '--resume');
    rejectListOption(values['allow-steer'], '--allow-steer');
    rejectListOption(values.turn, '--turn');
    rejectListOption(values.messages, '--messages');
    rejectListOption(values.type, '--type');
    rejectListOption(values['message-title'], '--message-title');
    rejectListOption(values['message-style'], '--message-style');
    rejectListOption(values.color, '--color');
    rejectListOption(values.markdown, '--markdown');
    rejectListOption(values.collapsible, '--collapsible');
    rejectListOption(values.format, '--format');
    rejectListOption(values.exclude, '--exclude');
    rejectListOption(values.output, '--output');
    rejectListOption(values.force, '--force');
    rejectListOption(values['context-window-size'], '--context-window-size');
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

  if (values.json !== undefined) {
    throw argumentError('--json can only be used with list, status, or wait');
  }
  if (values.turn !== undefined) throw argumentError('--turn can only be used with wait');
  if (values.messages !== undefined) throw argumentError('--messages can only be used with status');
  if (values['allow-steer'] !== undefined) {
    throw argumentError('--allow-steer can only be used with send-async');
  }
  if (values.type !== undefined) throw argumentError('--type can only be used with add-row');
  if (values.markdown !== undefined) throw argumentError('--markdown can only be used with add-row');
  if (values.format !== undefined) throw argumentError('--format can only be used with export');
  if (values.exclude !== undefined) throw argumentError('--exclude can only be used with export');
  if (values['context-window-size'] !== undefined) {
    throw argumentError('--context-window-size can only be used with handoff');
  }
  if (values.output !== undefined) {
    throw argumentError('--output can only be used with export or handoff');
  }
  if (values.force !== undefined) {
    throw argumentError('--force can only be used with export or handoff');
  }
  const title = nonEmptyOption(values.title as string | undefined, '--title')?.trim();
  const userMessagePresentation = parseUserMessagePresentationOptions(values);
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
    ...(userMessagePresentation === undefined ? {} : { userMessagePresentation }),
    ...modes,
    prompt,
    readsPromptFromStdin,
  };

  if (resume !== undefined) {
    if (cwd !== undefined) throw argumentError('--cwd cannot be used with --resume');
    if (parent !== undefined) throw argumentError('--parent cannot be used with --resume');
    return { kind: 'resume', ...shared, chatId: parseChatIdOption(resume, '--resume') };
  }

  if (agentId === undefined) throw argumentError('--agent is required for a new chat');
  if (model === undefined) throw argumentError('--model is required for a new chat');
  const parentChatId = parent === undefined ? undefined : parseChatIdOption(parent, '--parent');
  return {
    kind: 'start',
    ...shared,
    agentId,
    model,
    cwd: path.resolve(currentDirectory, cwd ?? '.'),
    ...(parentChatId === undefined ? {} : { parentChatId }),
  };
}
