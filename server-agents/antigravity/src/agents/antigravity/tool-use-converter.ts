import {
  BashToolUseMessage,
  EditToolUseMessage,
  ExternalToolUseMessage,
  McpToolUseMessage,
  ReadToolUseMessage,
  TaskToolUseMessage,
  UnknownToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
  type ToolUseChatMessage,
} from '@garcon/common/chat-types';
import { asObject, asString } from '@garcon/server-agent-common/acp/event-converter';

export const ANTIGRAVITY_TOOL_NAMESPACE = 'antigravity';

// Native tools with no shared counterpart. They render as named provider tools
// rather than unknown ones.
const NATIVE_EXTERNAL_TOOLS = new Set([
  'ask_question',
  'define_subagent',
  'manage_subagents',
  'manage_task',
  'run_workflow',
  'schedule',
  'send_message',
  'swarm',
]);

export interface AntigravityToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

// Tool arguments arrive in PascalCase from 1.5 and snake_case from older builds
// (t3code apps/server/src/provider/acp/AntigravityProtocol.ts:444-512 at be91767).
function field(input: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (input[name] !== undefined) return input[name];
  }
  return undefined;
}

function stringField(input: Record<string, unknown>, ...names: string[]): string | undefined {
  return asString(field(input, ...names));
}

function lineField(input: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = field(input, ...names);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

// Reads the tool identity from a `tool_call` update or a permission's `toolCall`.
export function antigravityToolCall(raw: Record<string, unknown>): AntigravityToolCall | null {
  const toolCallId = asString(raw.toolCallId);
  if (!toolCallId) return null;
  return {
    toolCallId,
    name: asString(raw.name) ?? asString(raw.kind) ?? 'unknown',
    input: asObject(raw.rawInput ?? raw.args),
  };
}

export function convertAntigravityToolUse(
  timestamp: string,
  call: AntigravityToolCall,
): ToolUseChatMessage {
  const { toolCallId: id, name, input } = call;
  switch (name) {
    case 'run_command': {
      const command = stringField(input, 'CommandLine', 'command_line', 'commandLine', 'command');
      if (command === undefined) break;
      return new BashToolUseMessage(timestamp, id, command, stringField(input, 'toolSummary'));
    }
    case 'read_file': {
      const path = stringField(input, 'Path', 'path', 'AbsolutePath', 'file_path');
      if (path === undefined) break;
      return new ReadToolUseMessage(
        timestamp,
        id,
        path,
        lineField(input, 'StartLine', 'start_line'),
        undefined,
        lineField(input, 'EndLine', 'end_line'),
      );
    }
    case 'write_file': {
      const path = stringField(input, 'Path', 'path', 'TargetFile', 'file_path');
      if (path === undefined) break;
      return new WriteToolUseMessage(timestamp, id, path, stringField(input, 'Content', 'content', 'CodeContent'));
    }
    case 'edit_file': {
      const path = stringField(input, 'Path', 'path', 'TargetFile', 'file_path');
      if (path === undefined) break;
      return new EditToolUseMessage(
        timestamp,
        id,
        path,
        stringField(input, 'Target', 'target', 'TargetContent'),
        stringField(input, 'Replacement', 'replacement', 'ReplacementContent'),
      );
    }
    case 'search_web': {
      const query = stringField(input, 'query', 'Query');
      if (query === undefined) break;
      return new WebSearchToolUseMessage(timestamp, id, query);
    }
    case 'invoke_subagent': {
      const role = stringField(input, 'Role', 'role');
      return new TaskToolUseMessage(
        timestamp,
        id,
        stringField(input, 'TypeName', 'type_name') ?? role,
        role,
        stringField(input, 'Prompt', 'prompt'),
        stringField(input, 'Model', 'model'),
      );
    }
    case 'call_mcp_tool': {
      const server = stringField(input, 'ServerName', 'server_name');
      const tool = stringField(input, 'ToolName', 'tool_name');
      if (server && tool) return new McpToolUseMessage(timestamp, id, server, tool, asObject(field(input, 'Arguments', 'arguments')));
      break;
    }
  }
  const mcpServer = asString(input.server);
  const mcpTool = asString(input.tool);
  if (mcpServer && mcpTool) {
    return new McpToolUseMessage(timestamp, id, mcpServer, mcpTool, asObject(input.arguments ?? input.args));
  }
  if (NATIVE_EXTERNAL_TOOLS.has(name)) {
    return new ExternalToolUseMessage(timestamp, id, name, input, ANTIGRAVITY_TOOL_NAMESPACE);
  }
  return new UnknownToolUseMessage(timestamp, id, name, input);
}

// Command results lead with `Created At:`/`Completed At:` timestamps that carry
// no information for the transcript.
export function antigravityToolResultText(name: string, text: string): string {
  if (name !== 'run_command') return text;
  return text.replace(/^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?/, '');
}
