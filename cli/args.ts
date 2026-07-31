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
import { argumentError } from './errors.js';

export const CLI_HELP = `Usage:
  garcon-cli [options] <prompt>
  garcon-cli [options] --resume <chat-id> <prompt>

Starts or resumes a visible chat through an already-running Garcon server.
The selected permission mode may allow the agent to edit files and run tools.

Options:
  --workspace <name>           Named Garcon data workspace (default: default)
  --config-dir <path>          Garcon config root (default: ~/.garcon)
  --server <url>               Verified loopback server URL override
  --cwd <path>                 Project directory for a new chat (default: current directory)
  --agent <id>                 Agent ID; required for a new chat
  --provider <id>              Configured API provider ID
  --endpoint <id>              Endpoint ID within --provider
  --model <id>                 Model value or raw model; required for a new chat
  --permissions <mode>         Permission mode: ${PERMISSION_MODE_VALUES.join(', ')}
  --reasoning-effort <mode>    Reasoning effort: ${THINKING_MODE_VALUES.join(', ')}
  --resume <chat-id>           Resume an existing chat
  --help                       Show this help
  --version                    Show the Garcon version

Use a single - as the prompt to read UTF-8 text from stdin.`;

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

interface CliInvocationBase extends CliSelectionOptions {
  kind: 'start' | 'resume';
  workspace: string;
  configDir: string;
  serverUrl?: string;
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

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | CliInvocation;

const STRING_OPTIONS = [
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
  'resume',
] as const;

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

function parseModeOptions(values: Record<string, boolean | string | undefined>): {
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
} {
  const permission = values.permissions;
  if (permission !== undefined && !isPermissionMode(permission)) {
    throw argumentError(`--permissions must be one of: ${PERMISSION_MODE_VALUES.join(', ')}`);
  }
  const thinking = values['reasoning-effort'];
  if (thinking !== undefined && !isThinkingMode(thinking)) {
    throw argumentError(`--reasoning-effort must be one of: ${THINKING_MODE_VALUES.join(', ')}`);
  }
  return {
    ...(permission === undefined ? {} : { permissionMode: permission }),
    ...(thinking === undefined ? {} : { thinkingMode: thinking }),
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
        resume: { type: 'string' },
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
    if (token.kind !== 'option' || !STRING_OPTIONS.includes(token.name as typeof STRING_OPTIONS[number])) {
      continue;
    }
    if (observed.has(token.name)) repeated.add(token.name);
    observed.add(token.name);
  }
  if (repeated.size > 0) {
    throw argumentError(`option may be specified only once: --${[...repeated][0]}`);
  }

  const values = parsed.values as Record<string, boolean | string | undefined>;
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
  const modes = parseModeOptions(values);

  if (endpointId !== undefined && providerId === undefined) {
    throw argumentError('--endpoint requires --provider');
  }
  if (resume !== undefined && (providerId !== undefined || endpointId !== undefined) && model === undefined) {
    throw argumentError('--provider and --endpoint require --model when resuming');
  }

  if (parsed.positionals.length === 0) throw argumentError('a prompt is required');
  const readsPromptFromStdin = parsed.positionals.length === 1 && parsed.positionals[0] === '-';
  const prompt = readsPromptFromStdin ? null : parsed.positionals.join(' ').trim();
  if (prompt !== null && prompt.length === 0) throw argumentError('the prompt must not be empty');

  const shared = {
    workspace,
    configDir,
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(model === undefined ? {} : { model }),
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
