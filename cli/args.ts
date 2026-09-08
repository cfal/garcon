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
import { isAgentId, type AgentId } from '@garcon/common/agents';
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
import {
  isPreambleId,
  PREAMBLE_MAX_COUNT,
  type PreambleId,
} from '@garcon/common/preambles';
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
import {
  CHAT_SEARCH_DEFAULT_PAGE_SIZE,
  CHAT_SEARCH_MAX_OFFSET,
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
  CHAT_SEARCH_SORT_VALUES,
  type ChatSearchSort,
} from '@garcon/common/chat-search';
import {
  TRANSCRIPT_ENTRY_CATEGORY_ALIASES,
  TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES,
  canonicalTranscriptEntryOptionalCategories,
  isTranscriptEntryOptionalCategory,
  type TranscriptEntryOptionalCategory,
} from '@garcon/common/transcript-entry-categories';
import {
  NativeSessionLookupValidationError,
  parseNativeSessionId,
} from '@garcon/common/native-session-lookup';
import { argumentError } from './errors.js';

const ADD_ROW_PRESENTATION_REQUIREMENT = [
  ...CLI_PRESET_PRESENTATION_STYLES.map((style) => `--type ${style}`),
  '--color',
].join(' or ');

export const CLI_HELP = `Usage:
  garcon-cli [options] start [--parent <chat-id>] [--no-preamble | --preamble <id>...] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>
  garcon-cli [options] start-async [--parent <chat-id>] [--no-preamble | --preamble <id>...] [--json] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>
  garcon-cli [options] resume <chat-id> [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>
  garcon-cli [options] resume-async <chat-id> [--allow-steer] [--json] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <message>
  garcon-cli [options] list <resource>
  garcon-cli [options] stop <chat-id> [--json]
  garcon-cli [connection options] permission-decision <chat-id> <occurrence-id> <allow|deny> --run <run-id> --server-instance <instance-id> [--json]
  garcon-cli [connection options] archive|unarchive|pin|unpin <chat-id> [--json]
  garcon-cli [connection options] rename <chat-id> <title> [--json]
  garcon-cli [connection options] set-tags <chat-id> (--tag <tag>... | --clear) [--json]
  garcon-cli [connection options] add-row <chat-id> (--type <info|notice|error> | --color <light[,dark]>) [--title <title>] [--markdown] [--collapsible] <content>
  garcon-cli [connection options] status <chat-id> [--messages <count>] [--json]
  garcon-cli [connection options] chats [--filter <expression>] [--limit <count>] [--offset <count>] [--json]
  garcon-cli [connection options] search <query> [--filter <expression>] [--sort <relevance|activity|created>] [--limit <count>] [--offset <count>] [--snippets <count>] [--json]
  garcon-cli [connection options] read <chat-id> <ordinal> [-B <count>] [-A <count>] [--include <category>]... [--transcript-view-id <id>] [--json]
  garcon-cli [connection options] wait <chat-id> --turn <turn-id> [--json]
  garcon-cli [connection options] export <chat-id> [--format <markdown|xml>] [--exclude <category>]... [--output <path>] [--force]
  garcon-cli [connection options] handoff <chat-id> [--context-window-size <tokens>] [--output <path>] [--force]
  garcon-cli [connection options] lookup-native-session <native-session-id> [--agent <agent-id>]

start and resume wait for the accepted turn. start-async and resume-async return after acceptance.
The selected permission mode may allow the agent to edit files and run tools.
resume-async inherits the chat's saved execution settings, so it may edit files
or run tools. Use - as the message to read UTF-8 text from stdin. stop uses the same command as the SPA
Stop button and interrupts the active turn. If queued messages exist, stop
pauses the queue; resume it in Garcon before sending a new direct turn.
add-row appends one durable presentation-only CLI row to chat history.
It never sends, queues, or exposes the row to the agent.
export writes the complete untruncated transcript as Markdown or XML. Exclusions
apply to top-level entries; tool calls embedded in permission entries remain.
handoff creates a read-only XML projection for another model to summarize. It
creates no chat, changes no agent or owner, starts no run, and appends nothing.
Lookup the Garcon chat associated with a native agent session ID.
Message presentation is not sent as prompt text. A message title without a style
uses notice; a style without a title displays its CLI label. --color selects custom styling.
--collapsible starts the CLI-authored body collapsed without requiring a style.
Ordinary restart, replay, shares, and frozen forks preserve it. Native-history
Reload and provider-native fork segments may drop Garcon-only presentation.

List resources:
  agents
  preambles                 Lists IDs, titles, enabled state, and scope
  providers                 Optionally filter with --agent or --provider
  endpoints                 Requires --provider; optionally filter with --agent or --endpoint
  models                    Requires --agent; optionally filter with --provider and --endpoint
  permissions               Requires --agent
  reasoning-efforts         Requires --agent

Chat research:
  chats filters the complete visible metadata snapshot and sorts by activity.
  search performs paged lexical transcript search; quoted phrases are adjacent,
  while separate terms may match different entries in the same chat.
  read shows bounded context around one durable ordinal. It defaults to the
  conversation spine; use --include tools for tool calls and results.
  Search coverage warnings are diagnostics. A truncated or partially indexed
  result cannot establish that no other matching chat exists.
  Metadata filters include exact id:<chat-id> and direct parent:<chat-id>, plus
  created-before/after and updated-before/after. Date-only values use midnight
  UTC; timestamps require an RFC3339 timezone. updated means transcript/list
  activity, not title, tag, pin, or archive modification time.

Options:
  --workspace <name>           Named Garcon data workspace (default: default)
  --config-dir <path>          Garcon config root (default: ~/.garcon)
  --server <url>               Assert the workspace descriptor's exact URL
  --cwd <path>                 Project directory for a new chat (default: current directory)
  --parent <chat-id>           Record an existing parent for a new delegated chat
  --no-preamble               Disable all preambles for this new chat
  --preamble <id>             Select a preamble by UUID in order; repeatable
  --agent <id>                 Agent ID; required for a new chat and scoped lists, optional for native-session lookup
  --provider <id|name>          Configured API provider ID or exact unique name
  --endpoint <id>              Endpoint ID within --provider
  --model <id>                 Model value or raw model; required for a new chat
  --permissions <mode>         Permission mode: ${PERMISSION_MODE_VALUES.join(', ')}
  --reasoning-effort <mode>    Reasoning effort: ${THINKING_MODE_VALUES.join(', ')}
  --title <title>              Set a new-chat title or add-row heading
  --message-title <title>      Add a heading to this conversational CLI user message
  --message-style <style>      Style this CLI user message: info, notice, error, or custom
  --color <light[,dark]>       Custom six-digit hex accent; one value applies to both themes
  --tag <name>                 Add a tag; repeatable. New chats always receive cli
  --allow-steer                With resume-async, steer the active turn when busy; never queues
  --run <run-id>               Exact permission request run fence
  --server-instance <id>       Exact permission request server-instance fence
  --clear                      Replace the complete tag set with no tags
  --messages <count>           Status transcript entries, 0-${CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT} (default: ${CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT})
  --turn <turn-id>             Exact accepted turn to wait for
  --type <style>               Add-row style: info, notice, error, or custom
  --markdown                   Render add-row content as Markdown
  --collapsible                Start this CLI-authored content collapsed
  --format <markdown|xml>      Transcript export format (default: markdown)
  --exclude <category>         Export exclusion; repeatable or comma-separated:
                               ${TRANSCRIPT_EXPORT_CATEGORIES.join(', ')}; tools excludes calls and results
  --filter <expression>        Chat metadata filter expression
  --sort <mode>                Search ordering: ${CHAT_SEARCH_SORT_VALUES.join(', ')}
  --limit <count>              chats/search page size, 1-${CHAT_SEARCH_MAX_PAGE_SIZE}
  --offset <count>             chats/search page offset
  --snippets <count>           Search snippets per chat, 1-${CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT}
  -B, --before-context <count> Read entries before the anchor, 0-100 (default: 5)
  -A, --after-context <count>  Read entries after the anchor, 0-100 (default: 5)
  --include <category>         Read category; repeatable or comma-separated:
                               ${TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES.join(', ')}; tools includes calls and results
  --transcript-view-id <id>    Require the read anchor to remain in this transcript view
  --context-window-size <tokens>
                               Context window of the model that will read the
                               handoff artifact (default: ${DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS}). Garcon limits
                               the artifact to 75% of this token capacity using
                               an estimate; token usage varies by model.
  --output <path>              Write export or handoff artifact atomically to a file
  --force                      Replace an existing export or handoff output file
  --json                       Print supported command results as JSON
  --help                       Show this help
  --version                    Show the Garcon version

Use a single - as the prompt to read UTF-8 text from stdin.
Use -- before prompt text that begins with an option-like token.
The cli tag records creation through garcon-cli; resume, resume-async, and stop never add it.`;

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
  orderedPreambleIds?: readonly PreambleId[];
}

export interface StartAsyncCliInvocation extends Omit<StartCliInvocation, 'kind'> {
  kind: 'start-async';
  json: boolean;
}

export interface ResumeCliInvocation extends CliInvocationBase {
  kind: 'resume';
  chatId: ChatId;
}

export type CliInvocation = StartCliInvocation | ResumeCliInvocation;

export const LIST_RESOURCE_VALUES = [
  'agents',
  'preambles',
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

export interface ResumeAsyncCliCommand extends CliConnectionOptions {
  kind: 'resume-async';
  chatId: ChatId;
  allowSteer: boolean;
  message: string | null;
  readsMessageFromStdin: boolean;
  json: boolean;
  userMessagePresentation?: UserMessagePresentation;
}

export interface StopCliCommand extends CliConnectionOptions {
  kind: 'stop';
  chatId: ChatId;
  json: boolean;
}

export interface PermissionDecisionCliCommand extends CliConnectionOptions {
  readonly kind: 'permission-decision';
  readonly chatId: ChatId;
  readonly permissionOccurrenceId: string;
  readonly runId: string;
  readonly serverInstanceId: string;
  readonly allow: boolean;
  readonly json: boolean;
}

export type ChatOrderMutationKind = 'archive' | 'unarchive' | 'pin' | 'unpin';

export type ChatOrderMutationCliCommand = {
  [Kind in ChatOrderMutationKind]: CliConnectionOptions & {
    readonly kind: Kind;
    readonly chatId: ChatId;
    readonly json: boolean;
  };
}[ChatOrderMutationKind];

export interface RenameCliCommand extends CliConnectionOptions {
  readonly kind: 'rename';
  readonly chatId: ChatId;
  readonly title: string;
  readonly json: boolean;
}

export interface SetTagsCliCommand extends CliConnectionOptions {
  readonly kind: 'set-tags';
  readonly chatId: ChatId;
  readonly tags: readonly string[];
  readonly json: boolean;
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

export interface LookupNativeSessionCliCommand extends CliConnectionOptions {
  readonly kind: 'lookup-native-session';
  readonly nativeSessionId: string;
  readonly agentId?: AgentId;
}

export interface ChatsCliCommand extends CliConnectionOptions {
  readonly kind: 'chats';
  readonly filter: string;
  readonly limit: number;
  readonly offset: number;
  readonly json: boolean;
}

export interface SearchCliCommand extends CliConnectionOptions {
  readonly kind: 'search';
  readonly query: string;
  readonly filter: string;
  readonly sort: ChatSearchSort;
  readonly limit: number;
  readonly offset: number;
  readonly snippetLimit: number;
  readonly json: boolean;
}

export interface ReadCliCommand extends CliConnectionOptions {
  readonly kind: 'read';
  readonly chatId: ChatId;
  readonly anchorOrdinal: number;
  readonly beforeContext: number;
  readonly afterContext: number;
  readonly includedCategories: readonly TranscriptEntryOptionalCategory[];
  readonly transcriptViewId?: string;
  readonly json: boolean;
}

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | ListCliCommand
  | ResumeAsyncCliCommand
  | StopCliCommand
  | PermissionDecisionCliCommand
  | ChatOrderMutationCliCommand
  | RenameCliCommand
  | SetTagsCliCommand
  | AddRowCliCommand
  | StatusCliCommand
  | WaitCliCommand
  | ExportCliCommand
  | HandoffCliCommand
  | LookupNativeSessionCliCommand
  | ChatsCliCommand
  | SearchCliCommand
  | ReadCliCommand
  | StartAsyncCliInvocation
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
  'turn',
  'messages',
  'type',
  'format',
  'output',
  'context-window-size',
  'filter',
  'sort',
  'limit',
  'offset',
  'snippets',
  'before-context',
  'after-context',
  'transcript-view-id',
  'run',
  'server-instance',
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

function parseTagOptions(value: ParsedOptionValue): string[] {
  const rawTags = value === undefined ? [] : value as string[];
  for (const tag of rawTags) {
    if (!normalizeTagSlug(tag)) throw argumentError('--tag must contain letters or numbers');
  }
  return normalizeTags(rawTags);
}

function parseAdditionalTags(value: ParsedOptionValue): string[] | undefined {
  const tags = parseTagOptions(value).filter((tag) => tag !== 'cli');
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

type ControlCommandKind =
  | 'resume-async'
  | 'stop'
  | 'add-row'
  | 'read'
  | 'permission-decision'
  | ChatOrderMutationKind
  | 'rename'
  | 'set-tags';

const CONNECTION_OPTION_KEYS = ['workspace', 'config-dir', 'server'] as const;

function optionSet(...keys: string[]): ReadonlySet<string> {
  return new Set([...CONNECTION_OPTION_KEYS, ...keys]);
}

function rejectOptionsExcept(
  values: Record<string, ParsedOptionValue>,
  allowed: ReadonlySet<string>,
  command: string,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(key)) {
      throw argumentError(`--${key} cannot be used with ${command}`);
    }
  }
}

const RESUME_ASYNC_OPTIONS = optionSet(
  'allow-steer',
  'message-title',
  'message-style',
  'color',
  'collapsible',
  'json',
);
const STOP_OPTIONS = optionSet('json');
const PERMISSION_DECISION_OPTIONS = optionSet('run', 'server-instance', 'json');
const CHAT_ORDER_MUTATION_OPTIONS = optionSet('json');
const RENAME_OPTIONS = optionSet('json');
const SET_TAGS_OPTIONS = optionSet('tag', 'clear', 'json');
const ADD_ROW_OPTIONS = optionSet('title', 'type', 'color', 'markdown', 'collapsible');
const WAIT_OPTIONS = optionSet('turn', 'json');
const STATUS_OPTIONS = optionSet('messages', 'json');
const EXPORT_OPTIONS = optionSet('format', 'exclude', 'output', 'force');
const HANDOFF_OPTIONS = optionSet('context-window-size', 'output', 'force');
const LOOKUP_NATIVE_SESSION_OPTIONS = optionSet('agent');
const CHATS_OPTIONS = optionSet('filter', 'limit', 'offset', 'json');
const SEARCH_OPTIONS = optionSet('filter', 'sort', 'limit', 'offset', 'snippets', 'json');
const READ_OPTIONS = optionSet(
  'before-context',
  'after-context',
  'include',
  'transcript-view-id',
  'json',
);
const LIST_OPTIONS = optionSet('agent', 'provider', 'endpoint', 'json');
const START_OPTIONS = optionSet(
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
  'tag',
  'collapsible',
  'no-preamble',
  'preamble',
);
const START_ASYNC_OPTIONS = new Set([...START_OPTIONS, 'json']);
const RESUME_OPTIONS = optionSet(
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
  'tag',
  'collapsible',
);

function parseControlChatId(value: string, command: ControlCommandKind): ChatId {
  try {
    return parseChatId(value);
  } catch (error) {
    throw argumentError(`${command} requires a valid Garcon chat ID`, { cause: error });
  }
}

function parseResumeAsync(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ResumeAsyncCliCommand {
  rejectOptionsExcept(values, RESUME_ASYNC_OPTIONS, 'resume-async');
  if (parsed.positionals.length !== 3) {
    throw argumentError('resume-async requires a chat ID and one message');
  }
  const chatId = parseControlChatId(parsed.positionals[1]!, 'resume-async');
  const messageArgument = parsed.positionals[2]!;
  const readsMessageFromStdin = messageArgument === '-';
  const message = readsMessageFromStdin ? null : messageArgument;
  if (message !== null && message.trim().length === 0) {
    throw argumentError('the message must not be empty');
  }
  const userMessagePresentation = parseUserMessagePresentationOptions(values);
  return {
    kind: 'resume-async',
    ...connection,
    chatId,
    allowSteer: values['allow-steer'] === true,
    message,
    readsMessageFromStdin,
    json: values.json === true,
    ...(userMessagePresentation === undefined ? {} : { userMessagePresentation }),
  };
}

function parseStop(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): StopCliCommand {
  rejectOptionsExcept(values, STOP_OPTIONS, 'stop');
  if (parsed.positionals.length !== 2) {
    throw argumentError('stop requires exactly one chat ID');
  }
  return {
    kind: 'stop',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'stop'),
    json: values.json === true,
  };
}

function parseOpaqueControlId(value: ParsedOptionValue, flag: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || !isCommandCorrelationIdWithinLimit(value)
  ) {
    throw argumentError(`${flag} requires one valid exact ID`);
  }
  return value;
}

function parsePermissionDecision(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): PermissionDecisionCliCommand {
  rejectOptionsExcept(values, PERMISSION_DECISION_OPTIONS, 'permission-decision');
  if (parsed.positionals.length !== 4) {
    throw argumentError(
      'permission-decision requires a chat ID, permission occurrence ID, and allow or deny',
    );
  }
  const decision = parsed.positionals[3];
  if (decision !== 'allow' && decision !== 'deny') {
    throw argumentError('permission-decision decision must be allow or deny');
  }
  return {
    kind: 'permission-decision',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'permission-decision'),
    permissionOccurrenceId: parseOpaqueControlId(
      parsed.positionals[2],
      'permission occurrence ID',
    ),
    runId: parseOpaqueControlId(values.run, '--run'),
    serverInstanceId: parseOpaqueControlId(values['server-instance'], '--server-instance'),
    allow: decision === 'allow',
    json: values.json === true,
  };
}

function parseChatOrderMutation(
  kind: ChatOrderMutationKind,
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ChatOrderMutationCliCommand {
  rejectOptionsExcept(values, CHAT_ORDER_MUTATION_OPTIONS, kind);
  if (parsed.positionals.length !== 2) {
    throw argumentError(`${kind} requires exactly one chat ID`);
  }
  return {
    kind,
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, kind),
    json: values.json === true,
  };
}

function parseRename(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): RenameCliCommand {
  rejectOptionsExcept(values, RENAME_OPTIONS, 'rename');
  if (parsed.positionals.length < 3) {
    throw argumentError('rename requires a chat ID and title');
  }
  const title = parsed.positionals.slice(2).join(' ').trim();
  if (!title) throw argumentError('rename title must not be empty');
  return {
    kind: 'rename',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'rename'),
    title,
    json: values.json === true,
  };
}

function parseSetTags(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): SetTagsCliCommand {
  rejectOptionsExcept(values, SET_TAGS_OPTIONS, 'set-tags');
  if (parsed.positionals.length !== 2) {
    throw argumentError('set-tags requires exactly one chat ID');
  }
  const clear = values.clear === true;
  const hasTags = values.tag !== undefined;
  if (clear === hasTags) {
    throw argumentError('set-tags requires either repeatable --tag or --clear');
  }
  return {
    kind: 'set-tags',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'set-tags'),
    tags: clear ? [] : parseTagOptions(values.tag),
    json: values.json === true,
  };
}

function parsePreambleSelection(
  values: Record<string, ParsedOptionValue>,
): readonly PreambleId[] | undefined {
  const noPreamble = values['no-preamble'] === true;
  const rawIds = values.preamble as string[] | undefined;
  if (noPreamble && rawIds !== undefined) {
    throw argumentError('--no-preamble cannot be combined with --preamble');
  }
  if (noPreamble) return [];
  if (rawIds === undefined) return undefined;
  if (rawIds.length > PREAMBLE_MAX_COUNT) {
    throw argumentError(`--preamble may be specified at most ${PREAMBLE_MAX_COUNT} times`);
  }
  const ids: PreambleId[] = [];
  const seen = new Set<string>();
  for (const rawId of rawIds) {
    if (!isPreambleId(rawId)) throw argumentError('--preamble must be a canonical UUID v4');
    if (seen.has(rawId)) throw argumentError('--preamble cannot contain duplicate IDs');
    seen.add(rawId);
    ids.push(rawId);
  }
  return ids;
}

function parseAddRow(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): AddRowCliCommand {
  rejectOptionsExcept(values, ADD_ROW_OPTIONS, 'add-row');
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

function parseWait(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): WaitCliCommand {
  rejectOptionsExcept(values, WAIT_OPTIONS, 'wait');
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
  rejectOptionsExcept(values, STATUS_OPTIONS, 'status');
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

function parseExport(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ExportCliCommand {
  rejectOptionsExcept(values, EXPORT_OPTIONS, 'export');
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
  rejectOptionsExcept(values, HANDOFF_OPTIONS, 'handoff');
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

function parseLookupNativeSession(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
  agentId: string | undefined,
): LookupNativeSessionCliCommand {
  rejectOptionsExcept(values, LOOKUP_NATIVE_SESSION_OPTIONS, 'lookup-native-session');
  if (parsed.positionals.length < 2) {
    throw argumentError('lookup-native-session requires one native session ID');
  }
  if (parsed.positionals.length > 2) {
    throw argumentError('lookup-native-session accepts exactly one native session ID');
  }
  let nativeSessionId: string;
  try {
    nativeSessionId = parseNativeSessionId(parsed.positionals[1]);
  } catch (error) {
    if (error instanceof NativeSessionLookupValidationError) {
      throw argumentError(error.message.replace('nativeSessionId', 'native session ID'), {
        cause: error,
      });
    }
    throw error;
  }
  if (agentId !== undefined && !isAgentId(agentId)) {
    throw argumentError('--agent must be a valid agent ID');
  }
  return {
    kind: 'lookup-native-session',
    ...connection,
    nativeSessionId,
    ...(agentId === undefined ? {} : { agentId }),
  };
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

function parseIncludedCategories(value: ParsedOptionValue): TranscriptEntryOptionalCategory[] {
  if (value === undefined) return [];
  const selected: TranscriptEntryOptionalCategory[] = [];
  for (const option of value as string[]) {
    for (const rawToken of option.split(',')) {
      const token = rawToken.trim();
      if (token.length === 0) throw argumentError('--include must not contain an empty category');
      if (Object.hasOwn(TRANSCRIPT_ENTRY_CATEGORY_ALIASES, token)) {
        selected.push(...TRANSCRIPT_ENTRY_CATEGORY_ALIASES[
          token as keyof typeof TRANSCRIPT_ENTRY_CATEGORY_ALIASES
        ]);
      } else if (isTranscriptEntryOptionalCategory(token)) {
        selected.push(token);
      } else {
        throw argumentError(
          `--include must be one of: ${TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES.join(', ')}, tools`,
        );
      }
    }
  }
  return canonicalTranscriptEntryOptionalCategories(selected);
}

function parseIntegerOption(
  value: ParsedOptionValue,
  flag: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const raw = value as string;
  if (!/^\d+$/.test(raw)) {
    throw argumentError(`${flag} must be an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw argumentError(`${flag} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseChats(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ChatsCliCommand {
  rejectOptionsExcept(values, CHATS_OPTIONS, 'chats');
  if (parsed.positionals.length !== 1) throw argumentError('chats accepts no positional arguments');
  return {
    kind: 'chats',
    ...connection,
    filter: nonEmptyOption(values.filter as string | undefined, '--filter') ?? '',
    limit: parseIntegerOption(values.limit, '--limit', 1, CHAT_SEARCH_MAX_PAGE_SIZE, 50),
    offset: parseIntegerOption(values.offset, '--offset', 0, Number.MAX_SAFE_INTEGER, 0),
    json: values.json === true,
  };
}

function parseSearch(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): SearchCliCommand {
  rejectOptionsExcept(values, SEARCH_OPTIONS, 'search');
  if (parsed.positionals.length < 2) throw argumentError('search requires a query');
  const query = parsed.positionals.slice(1).join(' ').trim();
  if (query.length === 0) throw argumentError('the search query must not be empty');
  const rawSort = values.sort ?? 'relevance';
  if (!CHAT_SEARCH_SORT_VALUES.includes(rawSort as ChatSearchSort)) {
    throw argumentError(`--sort must be one of: ${CHAT_SEARCH_SORT_VALUES.join(', ')}`);
  }
  return {
    kind: 'search',
    ...connection,
    query,
    filter: nonEmptyOption(values.filter as string | undefined, '--filter') ?? '',
    sort: rawSort as ChatSearchSort,
    limit: parseIntegerOption(
      values.limit,
      '--limit',
      1,
      CHAT_SEARCH_MAX_PAGE_SIZE,
      CHAT_SEARCH_DEFAULT_PAGE_SIZE,
    ),
    offset: parseIntegerOption(values.offset, '--offset', 0, CHAT_SEARCH_MAX_OFFSET, 0),
    snippetLimit: parseIntegerOption(
      values.snippets,
      '--snippets',
      1,
      CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
      CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
    ),
    json: values.json === true,
  };
}

function parseRead(
  parsed: ReturnType<typeof parseArgs>,
  values: Record<string, ParsedOptionValue>,
  connection: CliConnectionOptions,
): ReadCliCommand {
  rejectOptionsExcept(values, READ_OPTIONS, 'read');
  if (parsed.positionals.length !== 3) {
    throw argumentError('read requires one chat ID and one anchor ordinal');
  }
  const rawOrdinal = parsed.positionals[2]!;
  const anchorOrdinal = Number(rawOrdinal);
  if (!/^\d+$/.test(rawOrdinal) || anchorOrdinal < 1 || !Number.isSafeInteger(anchorOrdinal)) {
    throw argumentError('read requires a positive integer anchor ordinal');
  }
  const transcriptViewId = nonEmptyOption(
    values['transcript-view-id'] as string | undefined,
    '--transcript-view-id',
  );
  return {
    kind: 'read',
    ...connection,
    chatId: parseControlChatId(parsed.positionals[1]!, 'read'),
    anchorOrdinal,
    beforeContext: parseIntegerOption(
      values['before-context'],
      '--before-context',
      0,
      100,
      5,
    ),
    afterContext: parseIntegerOption(
      values['after-context'],
      '--after-context',
      0,
      100,
      5,
    ),
    includedCategories: parseIncludedCategories(values.include),
    ...(transcriptViewId === undefined ? {} : { transcriptViewId }),
    json: values.json === true,
  };
}

function parsePrompt(
  positionals: readonly string[],
  startIndex: number,
): { prompt: string | null; readsPromptFromStdin: boolean } {
  const promptArguments = positionals.slice(startIndex);
  if (promptArguments.length === 0) throw argumentError('a prompt is required');
  const readsPromptFromStdin = promptArguments.length === 1 && promptArguments[0] === '-';
  if (!readsPromptFromStdin && promptArguments.includes('-')) {
    throw argumentError('stdin marker - must be the only prompt argument');
  }
  const prompt = readsPromptFromStdin ? null : promptArguments.join(' ');
  if (prompt !== null && prompt.trim().length === 0) throw argumentError('the prompt must not be empty');
  return { prompt, readsPromptFromStdin };
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
        preamble: { type: 'string', multiple: true },
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
        turn: { type: 'string' },
        messages: { type: 'string' },
        type: { type: 'string' },
        format: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        output: { type: 'string' },
        'context-window-size': { type: 'string' },
        filter: { type: 'string' },
        sort: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
        snippets: { type: 'string' },
        'before-context': { type: 'string', short: 'B' },
        'after-context': { type: 'string', short: 'A' },
        include: { type: 'string', multiple: true },
        'transcript-view-id': { type: 'string' },
        run: { type: 'string' },
        'server-instance': { type: 'string' },
        force: { type: 'boolean' },
        'allow-steer': { type: 'boolean' },
        'no-preamble': { type: 'boolean' },
        clear: { type: 'boolean' },
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
  const additionalTags = parseAdditionalTags(values.tag);
  const connection = {
    workspace,
    configDir,
    ...(serverUrl === undefined ? {} : { serverUrl }),
  };

  const commandName = parsed.positionals[0];
  if (commandName === undefined) throw argumentError('a command is required');
  if (commandName === 'resume-async') return parseResumeAsync(parsed, values, connection);
  if (commandName === 'stop') return parseStop(parsed, values, connection);
  if (commandName === 'permission-decision') {
    return parsePermissionDecision(parsed, values, connection);
  }
  if (
    commandName === 'archive'
    || commandName === 'unarchive'
    || commandName === 'pin'
    || commandName === 'unpin'
  ) {
    return parseChatOrderMutation(commandName, parsed, values, connection);
  }
  if (commandName === 'rename') return parseRename(parsed, values, connection);
  if (commandName === 'set-tags') return parseSetTags(parsed, values, connection);
  if (commandName === 'add-row') return parseAddRow(parsed, values, connection);
  if (commandName === 'wait') return parseWait(parsed, values, connection);
  if (commandName === 'status') return parseStatus(parsed, values, connection);
  if (commandName === 'export') return parseExport(parsed, values, connection);
  if (commandName === 'handoff') return parseHandoff(parsed, values, connection);
  if (commandName === 'lookup-native-session') {
    return parseLookupNativeSession(parsed, values, connection, agentId);
  }
  if (commandName === 'chats') return parseChats(parsed, values, connection);
  if (commandName === 'search') return parseSearch(parsed, values, connection);
  if (commandName === 'read') return parseRead(parsed, values, connection);

  if (commandName === 'list') {
    const resource = parsed.positionals[1] ?? '';
    if (parsed.positionals.length !== 2 || !isListResource(resource)) {
      throw argumentError(`list requires one resource: ${LIST_RESOURCE_VALUES.join(', ')}`);
    }
    rejectOptionsExcept(values, LIST_OPTIONS, 'list');
    if (endpointId !== undefined && providerId === undefined) {
      throw argumentError('--endpoint requires --provider');
    }
    if (resource === 'agents') {
      if (agentId !== undefined) throw argumentError('--agent cannot be used with list agents');
      if (providerId !== undefined) throw argumentError('--provider cannot be used with list agents');
      if (endpointId !== undefined) throw argumentError('--endpoint cannot be used with list agents');
    }
    if (resource === 'preambles') {
      if (agentId !== undefined) throw argumentError('--agent cannot be used with list preambles');
      if (providerId !== undefined) {
        throw argumentError('--provider cannot be used with list preambles');
      }
      if (endpointId !== undefined) {
        throw argumentError('--endpoint cannot be used with list preambles');
      }
    }
    if (resource === 'providers' && endpointId !== undefined) {
      throw argumentError('--endpoint cannot be used with list providers');
    }
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
      if (providerId !== undefined) {
        throw argumentError(`--provider cannot be used with list ${resource}`);
      }
      if (endpointId !== undefined) {
        throw argumentError(`--endpoint cannot be used with list ${resource}`);
      }
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

  if (commandName !== 'start' && commandName !== 'start-async' && commandName !== 'resume') {
    throw argumentError(`unknown command: ${commandName}`);
  }
  let lifecycleOptions = START_OPTIONS;
  if (commandName === 'resume') lifecycleOptions = RESUME_OPTIONS;
  if (commandName === 'start-async') lifecycleOptions = START_ASYNC_OPTIONS;
  rejectOptionsExcept(values, lifecycleOptions, commandName);
  const title = nonEmptyOption(values.title as string | undefined, '--title')?.trim();
  const userMessagePresentation = parseUserMessagePresentationOptions(values);
  const modes = parseModeOptions(values);
  const orderedPreambleIds = commandName === 'resume'
    ? undefined
    : parsePreambleSelection(values);

  if (endpointId !== undefined && providerId === undefined) {
    throw argumentError('--endpoint requires --provider');
  }
  if (commandName === 'resume' && (providerId !== undefined || endpointId !== undefined) && model === undefined) {
    throw argumentError('--provider and --endpoint require --model when resuming');
  }

  if (commandName === 'resume' && parsed.positionals.length < 3) {
    throw argumentError('resume requires one chat ID and a prompt');
  }
  const promptInput = parsePrompt(parsed.positionals, commandName === 'resume' ? 2 : 1);

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
    ...promptInput,
  };

  if (commandName === 'resume') {
    return {
      kind: 'resume',
      ...shared,
      chatId: parseChatIdOption(parsed.positionals[1]!, 'resume chat ID'),
    };
  }

  if (agentId === undefined) throw argumentError('--agent is required for a new chat');
  if (model === undefined) throw argumentError('--model is required for a new chat');
  const parentChatId = parent === undefined ? undefined : parseChatIdOption(parent, '--parent');
  const start = {
    ...shared,
    agentId,
    model,
    cwd: path.resolve(currentDirectory, cwd ?? '.'),
    ...(parentChatId === undefined ? {} : { parentChatId }),
    ...(orderedPreambleIds === undefined ? {} : { orderedPreambleIds }),
  };
  return commandName === 'start-async'
    ? { kind: 'start-async', ...start, json: values.json === true }
    : { kind: 'start', ...start };
}
